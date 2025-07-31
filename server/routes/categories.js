const express = require('express');
const { body, validationResult } = require('express-validator');
const database = require('../config/database');
const { verifyToken, requireAdmin, requireStaff } = require('../middleware/auth');

const router = express.Router();

// Get all categories with hierarchy
router.get('/', verifyToken, requireStaff, async (req, res) => {
    try {
        const categories = await database.query(`
            SELECT 
                c.*,
                p.name as parent_name,
                COUNT(pr.id) as product_count
            FROM categories c
            LEFT JOIN categories p ON c.parent_id = p.id
            LEFT JOIN products pr ON c.id = pr.category_id AND pr.is_active = 1
            WHERE c.is_active = 1
            GROUP BY c.id
            ORDER BY c.parent_id ASC, c.name ASC
        `);

        // Build hierarchy
        const categoryMap = new Map();
        const rootCategories = [];

        // First pass: create category objects
        categories.forEach(cat => {
            categoryMap.set(cat.id, {
                ...cat,
                children: []
            });
        });

        // Second pass: build hierarchy
        categories.forEach(cat => {
            if (cat.parent_id) {
                const parent = categoryMap.get(cat.parent_id);
                if (parent) {
                    parent.children.push(categoryMap.get(cat.id));
                }
            } else {
                rootCategories.push(categoryMap.get(cat.id));
            }
        });

        res.json({
            success: true,
            data: {
                categories: rootCategories,
                total: categories.length
            }
        });

    } catch (error) {
        console.error('Get categories error:', error);
        res.status(500).json({
            success: false,
            message: 'Server error'
        });
    }
});

// Get flat list of categories (for dropdowns)
router.get('/flat', verifyToken, requireStaff, async (req, res) => {
    try {
        const categories = await database.query(`
            SELECT 
                c.id,
                c.name,
                c.parent_id,
                p.name as parent_name,
                CASE 
                    WHEN c.parent_id IS NOT NULL THEN p.name || ' > ' || c.name
                    ELSE c.name
                END as display_name
            FROM categories c
            LEFT JOIN categories p ON c.parent_id = p.id
            WHERE c.is_active = 1
            ORDER BY display_name ASC
        `);

        res.json({
            success: true,
            data: { categories }
        });

    } catch (error) {
        console.error('Get flat categories error:', error);
        res.status(500).json({
            success: false,
            message: 'Server error'
        });
    }
});

// Get category by ID
router.get('/:id', verifyToken, requireStaff, async (req, res) => {
    try {
        const { id } = req.params;

        const category = await database.get(`
            SELECT 
                c.*,
                p.name as parent_name,
                COUNT(pr.id) as product_count
            FROM categories c
            LEFT JOIN categories p ON c.parent_id = p.id
            LEFT JOIN products pr ON c.id = pr.category_id AND pr.is_active = 1
            WHERE c.id = ? AND c.is_active = 1
            GROUP BY c.id
        `, [id]);

        if (!category) {
            return res.status(404).json({
                success: false,
                message: 'Category not found'
            });
        }

        // Get subcategories
        const subcategories = await database.query(`
            SELECT id, name, description, created_at
            FROM categories
            WHERE parent_id = ? AND is_active = 1
            ORDER BY name ASC
        `, [id]);

        res.json({
            success: true,
            data: {
                category: {
                    ...category,
                    subcategories
                }
            }
        });

    } catch (error) {
        console.error('Get category error:', error);
        res.status(500).json({
            success: false,
            message: 'Server error'
        });
    }
});

// Create category
router.post('/', [
    verifyToken,
    requireAdmin,
    body('name').notEmpty().trim().withMessage('Category name is required'),
    body('description').optional().trim(),
    body('parent_id').optional().isInt().withMessage('Parent ID must be a number')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({
                success: false,
                message: 'Validation failed',
                errors: errors.array()
            });
        }

        const { name, description, parent_id } = req.body;

        // Check if parent exists (if provided)
        if (parent_id) {
            const parent = await database.get(
                'SELECT id FROM categories WHERE id = ? AND is_active = 1',
                [parent_id]
            );
            
            if (!parent) {
                return res.status(400).json({
                    success: false,
                    message: 'Parent category not found'
                });
            }
        }

        // Check for duplicate name at same level
        const existingQuery = parent_id 
            ? 'SELECT id FROM categories WHERE name = ? AND parent_id = ? AND is_active = 1'
            : 'SELECT id FROM categories WHERE name = ? AND parent_id IS NULL AND is_active = 1';
        
        const existingParams = parent_id ? [name, parent_id] : [name];
        const existing = await database.get(existingQuery, existingParams);

        if (existing) {
            return res.status(400).json({
                success: false,
                message: 'Category with this name already exists at this level'
            });
        }

        // Create category
        const result = await database.run(
            'INSERT INTO categories (name, description, parent_id) VALUES (?, ?, ?)',
            [name, description || null, parent_id || null]
        );

        // Get created category
        const newCategory = await database.get(`
            SELECT 
                c.*,
                p.name as parent_name
            FROM categories c
            LEFT JOIN categories p ON c.parent_id = p.id
            WHERE c.id = ?
        `, [result.id]);

        res.status(201).json({
            success: true,
            message: 'Category created successfully',
            data: { category: newCategory }
        });

    } catch (error) {
        console.error('Create category error:', error);
        res.status(500).json({
            success: false,
            message: 'Server error'
        });
    }
});

// Update category
router.put('/:id', [
    verifyToken,
    requireAdmin,
    body('name').notEmpty().trim().withMessage('Category name is required'),
    body('description').optional().trim(),
    body('parent_id').optional().isInt().withMessage('Parent ID must be a number')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({
                success: false,
                message: 'Validation failed',
                errors: errors.array()
            });
        }

        const { id } = req.params;
        const { name, description, parent_id } = req.body;

        // Check if category exists
        const category = await database.get(
            'SELECT * FROM categories WHERE id = ? AND is_active = 1',
            [id]
        );

        if (!category) {
            return res.status(404).json({
                success: false,
                message: 'Category not found'
            });
        }

        // Check if parent exists and prevent circular reference
        if (parent_id) {
            if (parent_id == id) {
                return res.status(400).json({
                    success: false,
                    message: 'Category cannot be its own parent'
                });
            }

            const parent = await database.get(
                'SELECT id FROM categories WHERE id = ? AND is_active = 1',
                [parent_id]
            );
            
            if (!parent) {
                return res.status(400).json({
                    success: false,
                    message: 'Parent category not found'
                });
            }

            // Check for circular reference (parent trying to be child of its descendant)
            const descendants = await getDescendants(id);
            if (descendants.includes(parent_id)) {
                return res.status(400).json({
                    success: false,
                    message: 'Cannot create circular reference'
                });
            }
        }

        // Check for duplicate name at same level (excluding current category)
        const existingQuery = parent_id 
            ? 'SELECT id FROM categories WHERE name = ? AND parent_id = ? AND id != ? AND is_active = 1'
            : 'SELECT id FROM categories WHERE name = ? AND parent_id IS NULL AND id != ? AND is_active = 1';
        
        const existingParams = parent_id ? [name, parent_id, id] : [name, id];
        const existing = await database.get(existingQuery, existingParams);

        if (existing) {
            return res.status(400).json({
                success: false,
                message: 'Category with this name already exists at this level'
            });
        }

        // Update category
        await database.run(
            'UPDATE categories SET name = ?, description = ?, parent_id = ? WHERE id = ?',
            [name, description || null, parent_id || null, id]
        );

        // Get updated category
        const updatedCategory = await database.get(`
            SELECT 
                c.*,
                p.name as parent_name
            FROM categories c
            LEFT JOIN categories p ON c.parent_id = p.id
            WHERE c.id = ?
        `, [id]);

        res.json({
            success: true,
            message: 'Category updated successfully',
            data: { category: updatedCategory }
        });

    } catch (error) {
        console.error('Update category error:', error);
        res.status(500).json({
            success: false,
            message: 'Server error'
        });
    }
});

// Delete category
router.delete('/:id', verifyToken, requireAdmin, async (req, res) => {
    try {
        const { id } = req.params;

        // Check if category exists
        const category = await database.get(
            'SELECT * FROM categories WHERE id = ? AND is_active = 1',
            [id]
        );

        if (!category) {
            return res.status(404).json({
                success: false,
                message: 'Category not found'
            });
        }

        // Check if category has products
        const productCount = await database.get(
            'SELECT COUNT(*) as count FROM products WHERE category_id = ? AND is_active = 1',
            [id]
        );

        if (productCount.count > 0) {
            return res.status(400).json({
                success: false,
                message: `Cannot delete category. It has ${productCount.count} products assigned to it.`
            });
        }

        // Check if category has subcategories
        const subcategoryCount = await database.get(
            'SELECT COUNT(*) as count FROM categories WHERE parent_id = ? AND is_active = 1',
            [id]
        );

        if (subcategoryCount.count > 0) {
            return res.status(400).json({
                success: false,
                message: `Cannot delete category. It has ${subcategoryCount.count} subcategories.`
            });
        }

        // Soft delete category
        await database.run(
            'UPDATE categories SET is_active = 0 WHERE id = ?',
            [id]
        );

        res.json({
            success: true,
            message: 'Category deleted successfully'
        });

    } catch (error) {
        console.error('Delete category error:', error);
        res.status(500).json({
            success: false,
            message: 'Server error'
        });
    }
});

// Helper function to get all descendants of a category
async function getDescendants(categoryId) {
    const descendants = [];
    const queue = [categoryId];

    while (queue.length > 0) {
        const currentId = queue.shift();
        const children = await database.query(
            'SELECT id FROM categories WHERE parent_id = ? AND is_active = 1',
            [currentId]
        );

        for (const child of children) {
            descendants.push(child.id);
            queue.push(child.id);
        }
    }

    return descendants;
}

module.exports = router;