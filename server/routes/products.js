const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { body, validationResult } = require('express-validator');
const database = require('../config/database');
const { verifyToken, requireAdmin, requireStaff } = require('../middleware/auth');

const router = express.Router();

// Configure multer for image uploads
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const uploadDir = path.join(__dirname, '../uploads/products');
        if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir, { recursive: true });
        }
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, 'product-' + uniqueSuffix + path.extname(file.originalname));
    }
});

const upload = multer({
    storage: storage,
    limits: {
        fileSize: 5 * 1024 * 1024 // 5MB limit
    },
    fileFilter: (req, file, cb) => {
        const allowedTypes = /jpeg|jpg|png|gif|webp/;
        const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
        const mimetype = allowedTypes.test(file.mimetype);

        if (mimetype && extname) {
            return cb(null, true);
        } else {
            cb(new Error('Only image files are allowed'));
        }
    }
});

// Get all products with filtering, sorting, and pagination
router.get('/', verifyToken, requireStaff, async (req, res) => {
    try {
        const {
            page = 1,
            limit = 20,
            search = '',
            category_id = '',
            sort_by = 'name',
            sort_order = 'ASC',
            low_stock = false
        } = req.query;

        const offset = (page - 1) * limit;
        let whereConditions = ['p.is_active = 1'];
        let queryParams = [];

        // Search filter
        if (search) {
            whereConditions.push('(p.name LIKE ? OR p.sku LIKE ? OR p.barcode LIKE ? OR p.brand LIKE ?)');
            const searchTerm = `%${search}%`;
            queryParams.push(searchTerm, searchTerm, searchTerm, searchTerm);
        }

        // Category filter
        if (category_id) {
            whereConditions.push('p.category_id = ?');
            queryParams.push(category_id);
        }

        // Low stock filter
        if (low_stock === 'true') {
            whereConditions.push('s.quantity <= p.min_stock_level');
        }

        const whereClause = whereConditions.length > 0 ? 'WHERE ' + whereConditions.join(' AND ') : '';

        // Validate sort parameters
        const allowedSortFields = ['name', 'sku', 'price', 'quantity', 'created_at', 'brand'];
        const sortField = allowedSortFields.includes(sort_by) ? sort_by : 'name';
        const sortDirection = sort_order.toUpperCase() === 'DESC' ? 'DESC' : 'ASC';

        // Get products
        const productsQuery = `
            SELECT 
                p.*,
                c.name as category_name,
                s.quantity,
                s.reserved_quantity,
                (s.quantity - s.reserved_quantity) as available_quantity,
                CASE 
                    WHEN s.quantity <= p.min_stock_level THEN 1 
                    ELSE 0 
                END as is_low_stock
            FROM products p
            LEFT JOIN categories c ON p.category_id = c.id
            LEFT JOIN stock s ON p.id = s.product_id AND s.variant_id IS NULL
            ${whereClause}
            ORDER BY ${sortField === 'quantity' ? 's.quantity' : 'p.' + sortField} ${sortDirection}
            LIMIT ? OFFSET ?
        `;

        const products = await database.query(productsQuery, [...queryParams, parseInt(limit), offset]);

        // Get total count
        const countQuery = `
            SELECT COUNT(*) as total
            FROM products p
            LEFT JOIN stock s ON p.id = s.product_id AND s.variant_id IS NULL
            ${whereClause}
        `;
        const countResult = await database.get(countQuery, queryParams);

        res.json({
            success: true,
            data: {
                products,
                pagination: {
                    current_page: parseInt(page),
                    per_page: parseInt(limit),
                    total: countResult.total,
                    total_pages: Math.ceil(countResult.total / limit)
                }
            }
        });

    } catch (error) {
        console.error('Get products error:', error);
        res.status(500).json({
            success: false,
            message: 'Server error'
        });
    }
});

// Get product by ID
router.get('/:id', verifyToken, requireStaff, async (req, res) => {
    try {
        const { id } = req.params;

        const product = await database.get(`
            SELECT 
                p.*,
                c.name as category_name,
                s.quantity,
                s.reserved_quantity,
                (s.quantity - s.reserved_quantity) as available_quantity,
                CASE 
                    WHEN s.quantity <= p.min_stock_level THEN 1 
                    ELSE 0 
                END as is_low_stock
            FROM products p
            LEFT JOIN categories c ON p.category_id = c.id
            LEFT JOIN stock s ON p.id = s.product_id AND s.variant_id IS NULL
            WHERE p.id = ? AND p.is_active = 1
        `, [id]);

        if (!product) {
            return res.status(404).json({
                success: false,
                message: 'Product not found'
            });
        }

        // Get product variants
        const variants = await database.query(`
            SELECT 
                pv.*,
                s.quantity,
                s.reserved_quantity,
                (s.quantity - s.reserved_quantity) as available_quantity
            FROM product_variants pv
            LEFT JOIN stock s ON pv.id = s.variant_id
            WHERE pv.product_id = ? AND pv.is_active = 1
            ORDER BY pv.variant_name, pv.variant_value
        `, [id]);

        // Get recent stock movements
        const stockMovements = await database.query(`
            SELECT 
                sm.*,
                u.first_name || ' ' || u.last_name as created_by_name
            FROM stock_movements sm
            LEFT JOIN users u ON sm.created_by = u.id
            WHERE sm.product_id = ?
            ORDER BY sm.created_at DESC
            LIMIT 10
        `, [id]);

        res.json({
            success: true,
            data: {
                product: {
                    ...product,
                    variants,
                    recent_movements: stockMovements
                }
            }
        });

    } catch (error) {
        console.error('Get product error:', error);
        res.status(500).json({
            success: false,
            message: 'Server error'
        });
    }
});

// Create product
router.post('/', [
    verifyToken,
    requireAdmin,
    upload.single('image'),
    body('sku').notEmpty().trim().withMessage('SKU is required'),
    body('name').notEmpty().trim().withMessage('Product name is required'),
    body('price').isFloat({ min: 0 }).withMessage('Price must be a positive number'),
    body('category_id').optional().isInt().withMessage('Category ID must be a number'),
    body('brand').optional().trim(),
    body('unit_size').optional().trim(),
    body('cost').optional().isFloat({ min: 0 }).withMessage('Cost must be a positive number'),
    body('min_stock_level').optional().isInt({ min: 0 }).withMessage('Minimum stock level must be a non-negative integer'),
    body('barcode').optional().trim(),
    body('description').optional().trim()
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            // Delete uploaded file if validation fails
            if (req.file) {
                fs.unlink(req.file.path, () => {});
            }
            return res.status(400).json({
                success: false,
                message: 'Validation failed',
                errors: errors.array()
            });
        }

        const {
            sku,
            name,
            price,
            category_id,
            brand,
            unit_size,
            cost,
            min_stock_level,
            barcode,
            description
        } = req.body;

        // Check if SKU already exists
        const existingSku = await database.get(
            'SELECT id FROM products WHERE sku = ? AND is_active = 1',
            [sku]
        );

        if (existingSku) {
            if (req.file) {
                fs.unlink(req.file.path, () => {});
            }
            return res.status(400).json({
                success: false,
                message: 'Product with this SKU already exists'
            });
        }

        // Check if barcode already exists (if provided)
        if (barcode) {
            const existingBarcode = await database.get(
                'SELECT id FROM products WHERE barcode = ? AND is_active = 1',
                [barcode]
            );

            if (existingBarcode) {
                if (req.file) {
                    fs.unlink(req.file.path, () => {});
                }
                return res.status(400).json({
                    success: false,
                    message: 'Product with this barcode already exists'
                });
            }
        }

        // Check if category exists (if provided)
        if (category_id) {
            const categoryExists = await database.get(
                'SELECT id FROM categories WHERE id = ? AND is_active = 1',
                [category_id]
            );

            if (!categoryExists) {
                if (req.file) {
                    fs.unlink(req.file.path, () => {});
                }
                return res.status(400).json({
                    success: false,
                    message: 'Category not found'
                });
            }
        }

        // Handle image upload
        let imageUrl = null;
        if (req.file) {
            imageUrl = `/uploads/products/${req.file.filename}`;
        }

        await database.beginTransaction();

        try {
            // Create product
            const productResult = await database.run(`
                INSERT INTO products (
                    sku, name, price, category_id, brand, unit_size, cost, 
                    min_stock_level, barcode, description, image_url
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `, [
                sku,
                name,
                price,
                category_id || null,
                brand || null,
                unit_size || 'pcs',
                cost || null,
                min_stock_level || 0,
                barcode || null,
                description || null,
                imageUrl
            ]);

            // Create initial stock entry
            await database.run(
                'INSERT INTO stock (product_id, quantity) VALUES (?, ?)',
                [productResult.id, 0]
            );

            await database.commit();

            // Get created product with details
            const newProduct = await database.get(`
                SELECT 
                    p.*,
                    c.name as category_name,
                    s.quantity,
                    s.reserved_quantity
                FROM products p
                LEFT JOIN categories c ON p.category_id = c.id
                LEFT JOIN stock s ON p.id = s.product_id AND s.variant_id IS NULL
                WHERE p.id = ?
            `, [productResult.id]);

            res.status(201).json({
                success: true,
                message: 'Product created successfully',
                data: { product: newProduct }
            });

        } catch (error) {
            await database.rollback();
            if (req.file) {
                fs.unlink(req.file.path, () => {});
            }
            throw error;
        }

    } catch (error) {
        console.error('Create product error:', error);
        res.status(500).json({
            success: false,
            message: 'Server error'
        });
    }
});

// Update product
router.put('/:id', [
    verifyToken,
    requireAdmin,
    upload.single('image'),
    body('sku').notEmpty().trim().withMessage('SKU is required'),
    body('name').notEmpty().trim().withMessage('Product name is required'),
    body('price').isFloat({ min: 0 }).withMessage('Price must be a positive number'),
    body('category_id').optional().isInt().withMessage('Category ID must be a number'),
    body('brand').optional().trim(),
    body('unit_size').optional().trim(),
    body('cost').optional().isFloat({ min: 0 }).withMessage('Cost must be a positive number'),
    body('min_stock_level').optional().isInt({ min: 0 }).withMessage('Minimum stock level must be a non-negative integer'),
    body('barcode').optional().trim(),
    body('description').optional().trim()
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            if (req.file) {
                fs.unlink(req.file.path, () => {});
            }
            return res.status(400).json({
                success: false,
                message: 'Validation failed',
                errors: errors.array()
            });
        }

        const { id } = req.params;
        const {
            sku,
            name,
            price,
            category_id,
            brand,
            unit_size,
            cost,
            min_stock_level,
            barcode,
            description
        } = req.body;

        // Check if product exists
        const existingProduct = await database.get(
            'SELECT * FROM products WHERE id = ? AND is_active = 1',
            [id]
        );

        if (!existingProduct) {
            if (req.file) {
                fs.unlink(req.file.path, () => {});
            }
            return res.status(404).json({
                success: false,
                message: 'Product not found'
            });
        }

        // Check if SKU already exists (excluding current product)
        const existingSku = await database.get(
            'SELECT id FROM products WHERE sku = ? AND id != ? AND is_active = 1',
            [sku, id]
        );

        if (existingSku) {
            if (req.file) {
                fs.unlink(req.file.path, () => {});
            }
            return res.status(400).json({
                success: false,
                message: 'Product with this SKU already exists'
            });
        }

        // Check if barcode already exists (if provided, excluding current product)
        if (barcode) {
            const existingBarcode = await database.get(
                'SELECT id FROM products WHERE barcode = ? AND id != ? AND is_active = 1',
                [barcode, id]
            );

            if (existingBarcode) {
                if (req.file) {
                    fs.unlink(req.file.path, () => {});
                }
                return res.status(400).json({
                    success: false,
                    message: 'Product with this barcode already exists'
                });
            }
        }

        // Check if category exists (if provided)
        if (category_id) {
            const categoryExists = await database.get(
                'SELECT id FROM categories WHERE id = ? AND is_active = 1',
                [category_id]
            );

            if (!categoryExists) {
                if (req.file) {
                    fs.unlink(req.file.path, () => {});
                }
                return res.status(400).json({
                    success: false,
                    message: 'Category not found'
                });
            }
        }

        // Handle image upload
        let imageUrl = existingProduct.image_url;
        if (req.file) {
            // Delete old image if it exists
            if (existingProduct.image_url) {
                const oldImagePath = path.join(__dirname, '..', existingProduct.image_url);
                fs.unlink(oldImagePath, () => {});
            }
            imageUrl = `/uploads/products/${req.file.filename}`;
        }

        // Update product
        await database.run(`
            UPDATE products SET 
                sku = ?, name = ?, price = ?, category_id = ?, brand = ?, 
                unit_size = ?, cost = ?, min_stock_level = ?, barcode = ?, 
                description = ?, image_url = ?
            WHERE id = ?
        `, [
            sku,
            name,
            price,
            category_id || null,
            brand || null,
            unit_size || 'pcs',
            cost || null,
            min_stock_level || 0,
            barcode || null,
            description || null,
            imageUrl,
            id
        ]);

        // Get updated product with details
        const updatedProduct = await database.get(`
            SELECT 
                p.*,
                c.name as category_name,
                s.quantity,
                s.reserved_quantity
            FROM products p
            LEFT JOIN categories c ON p.category_id = c.id
            LEFT JOIN stock s ON p.id = s.product_id AND s.variant_id IS NULL
            WHERE p.id = ?
        `, [id]);

        res.json({
            success: true,
            message: 'Product updated successfully',
            data: { product: updatedProduct }
        });

    } catch (error) {
        console.error('Update product error:', error);
        res.status(500).json({
            success: false,
            message: 'Server error'
        });
    }
});

// Delete product
router.delete('/:id', verifyToken, requireAdmin, async (req, res) => {
    try {
        const { id } = req.params;

        // Check if product exists
        const product = await database.get(
            'SELECT * FROM products WHERE id = ? AND is_active = 1',
            [id]
        );

        if (!product) {
            return res.status(404).json({
                success: false,
                message: 'Product not found'
            });
        }

        // Check if product has been sold (has sale items)
        const saleItems = await database.get(
            'SELECT COUNT(*) as count FROM sale_items WHERE product_id = ?',
            [id]
        );

        if (saleItems.count > 0) {
            return res.status(400).json({
                success: false,
                message: 'Cannot delete product that has been sold. You can only deactivate it.'
            });
        }

        await database.beginTransaction();

        try {
            // Soft delete product
            await database.run(
                'UPDATE products SET is_active = 0 WHERE id = ?',
                [id]
            );

            // Deactivate variants
            await database.run(
                'UPDATE product_variants SET is_active = 0 WHERE product_id = ?',
                [id]
            );

            await database.commit();

            // Delete image file if it exists
            if (product.image_url) {
                const imagePath = path.join(__dirname, '..', product.image_url);
                fs.unlink(imagePath, () => {});
            }

            res.json({
                success: true,
                message: 'Product deleted successfully'
            });

        } catch (error) {
            await database.rollback();
            throw error;
        }

    } catch (error) {
        console.error('Delete product error:', error);
        res.status(500).json({
            success: false,
            message: 'Server error'
        });
    }
});

// Search products by barcode or SKU (for POS)
router.get('/search/:term', verifyToken, requireStaff, async (req, res) => {
    try {
        const { term } = req.params;

        const products = await database.query(`
            SELECT 
                p.id,
                p.sku,
                p.barcode,
                p.name,
                p.price,
                p.unit_size,
                c.name as category_name,
                s.quantity,
                s.reserved_quantity,
                (s.quantity - s.reserved_quantity) as available_quantity
            FROM products p
            LEFT JOIN categories c ON p.category_id = c.id
            LEFT JOIN stock s ON p.id = s.product_id AND s.variant_id IS NULL
            WHERE p.is_active = 1 
            AND (p.sku LIKE ? OR p.barcode LIKE ? OR p.name LIKE ?)
            ORDER BY p.name ASC
            LIMIT 10
        `, [`%${term}%`, `%${term}%`, `%${term}%`]);

        res.json({
            success: true,
            data: { products }
        });

    } catch (error) {
        console.error('Search products error:', error);
        res.status(500).json({
            success: false,
            message: 'Server error'
        });
    }
});

module.exports = router;