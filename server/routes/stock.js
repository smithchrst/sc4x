const express = require('express');
const { body, validationResult } = require('express-validator');
const database = require('../config/database');
const { verifyToken, requireAdmin, requireStaff } = require('../middleware/auth');

const router = express.Router();

// Get stock levels with low stock alerts
router.get('/', verifyToken, requireStaff, async (req, res) => {
    try {
        const {
            page = 1,
            limit = 50,
            low_stock_only = false,
            category_id = '',
            search = ''
        } = req.query;

        const offset = (page - 1) * limit;
        let whereConditions = ['p.is_active = 1'];
        let queryParams = [];

        // Low stock filter
        if (low_stock_only === 'true') {
            whereConditions.push('s.quantity <= p.min_stock_level');
        }

        // Category filter
        if (category_id) {
            whereConditions.push('p.category_id = ?');
            queryParams.push(category_id);
        }

        // Search filter
        if (search) {
            whereConditions.push('(p.name LIKE ? OR p.sku LIKE ? OR p.barcode LIKE ?)');
            const searchTerm = `%${search}%`;
            queryParams.push(searchTerm, searchTerm, searchTerm);
        }

        const whereClause = whereConditions.length > 0 ? 'WHERE ' + whereConditions.join(' AND ') : '';

        const stockQuery = `
            SELECT 
                p.id,
                p.sku,
                p.name,
                p.price,
                p.min_stock_level,
                p.unit_size,
                c.name as category_name,
                s.quantity,
                s.reserved_quantity,
                (s.quantity - s.reserved_quantity) as available_quantity,
                s.last_updated,
                CASE 
                    WHEN s.quantity <= p.min_stock_level THEN 1 
                    ELSE 0 
                END as is_low_stock,
                CASE 
                    WHEN s.quantity = 0 THEN 'out_of_stock'
                    WHEN s.quantity <= p.min_stock_level THEN 'low_stock'
                    ELSE 'in_stock'
                END as stock_status
            FROM products p
            LEFT JOIN categories c ON p.category_id = c.id
            LEFT JOIN stock s ON p.id = s.product_id AND s.variant_id IS NULL
            ${whereClause}
            ORDER BY is_low_stock DESC, s.quantity ASC, p.name ASC
            LIMIT ? OFFSET ?
        `;

        const stockItems = await database.query(stockQuery, [...queryParams, parseInt(limit), offset]);

        // Get total count
        const countQuery = `
            SELECT COUNT(*) as total
            FROM products p
            LEFT JOIN stock s ON p.id = s.product_id AND s.variant_id IS NULL
            ${whereClause}
        `;
        const countResult = await database.get(countQuery, queryParams);

        // Get low stock count
        const lowStockCount = await database.get(`
            SELECT COUNT(*) as count
            FROM products p
            LEFT JOIN stock s ON p.id = s.product_id AND s.variant_id IS NULL
            WHERE p.is_active = 1 AND s.quantity <= p.min_stock_level
        `);

        res.json({
            success: true,
            data: {
                stock_items: stockItems,
                low_stock_count: lowStockCount.count,
                pagination: {
                    current_page: parseInt(page),
                    per_page: parseInt(limit),
                    total: countResult.total,
                    total_pages: Math.ceil(countResult.total / limit)
                }
            }
        });

    } catch (error) {
        console.error('Get stock error:', error);
        res.status(500).json({
            success: false,
            message: 'Server error'
        });
    }
});

// Get stock movements history
router.get('/movements', verifyToken, requireStaff, async (req, res) => {
    try {
        const {
            page = 1,
            limit = 50,
            product_id = '',
            movement_type = '',
            date_from = '',
            date_to = ''
        } = req.query;

        const offset = (page - 1) * limit;
        let whereConditions = [];
        let queryParams = [];

        // Product filter
        if (product_id) {
            whereConditions.push('sm.product_id = ?');
            queryParams.push(product_id);
        }

        // Movement type filter
        if (movement_type) {
            whereConditions.push('sm.movement_type = ?');
            queryParams.push(movement_type);
        }

        // Date range filter
        if (date_from) {
            whereConditions.push('DATE(sm.created_at) >= ?');
            queryParams.push(date_from);
        }
        if (date_to) {
            whereConditions.push('DATE(sm.created_at) <= ?');
            queryParams.push(date_to);
        }

        const whereClause = whereConditions.length > 0 ? 'WHERE ' + whereConditions.join(' AND ') : '';

        const movementsQuery = `
            SELECT 
                sm.*,
                p.name as product_name,
                p.sku,
                pv.variant_name,
                pv.variant_value,
                u.first_name || ' ' || u.last_name as created_by_name
            FROM stock_movements sm
            LEFT JOIN products p ON sm.product_id = p.id
            LEFT JOIN product_variants pv ON sm.variant_id = pv.id
            LEFT JOIN users u ON sm.created_by = u.id
            ${whereClause}
            ORDER BY sm.created_at DESC
            LIMIT ? OFFSET ?
        `;

        const movements = await database.query(movementsQuery, [...queryParams, parseInt(limit), offset]);

        // Get total count
        const countQuery = `
            SELECT COUNT(*) as total
            FROM stock_movements sm
            ${whereClause}
        `;
        const countResult = await database.get(countQuery, queryParams);

        res.json({
            success: true,
            data: {
                movements,
                pagination: {
                    current_page: parseInt(page),
                    per_page: parseInt(limit),
                    total: countResult.total,
                    total_pages: Math.ceil(countResult.total / limit)
                }
            }
        });

    } catch (error) {
        console.error('Get stock movements error:', error);
        res.status(500).json({
            success: false,
            message: 'Server error'
        });
    }
});

// Adjust stock (manual adjustment)
router.post('/adjust', [
    verifyToken,
    requireAdmin,
    body('product_id').isInt().withMessage('Product ID is required'),
    body('adjustment_type').isIn(['in', 'out', 'adjustment']).withMessage('Invalid adjustment type'),
    body('quantity').isInt({ min: 1 }).withMessage('Quantity must be a positive integer'),
    body('notes').optional().trim()
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

        const { product_id, adjustment_type, quantity, notes, variant_id } = req.body;

        // Check if product exists
        const product = await database.get(
            'SELECT * FROM products WHERE id = ? AND is_active = 1',
            [product_id]
        );

        if (!product) {
            return res.status(404).json({
                success: false,
                message: 'Product not found'
            });
        }

        // Get current stock
        const currentStock = await database.get(
            'SELECT * FROM stock WHERE product_id = ? AND variant_id IS ?',
            [product_id, variant_id || null]
        );

        if (!currentStock) {
            return res.status(404).json({
                success: false,
                message: 'Stock record not found'
            });
        }

        const currentQuantity = currentStock.quantity;
        let newQuantity;

        // Calculate new quantity based on adjustment type
        switch (adjustment_type) {
            case 'in':
                newQuantity = currentQuantity + quantity;
                break;
            case 'out':
                newQuantity = Math.max(0, currentQuantity - quantity);
                break;
            case 'adjustment':
                newQuantity = quantity; // Direct adjustment to specific quantity
                break;
        }

        const quantityChange = newQuantity - currentQuantity;

        await database.beginTransaction();

        try {
            // Update stock
            await database.run(
                'UPDATE stock SET quantity = ?, updated_by = ? WHERE product_id = ? AND variant_id IS ?',
                [newQuantity, req.user.id, product_id, variant_id || null]
            );

            // Record stock movement
            await database.run(`
                INSERT INTO stock_movements (
                    product_id, variant_id, movement_type, quantity_change, 
                    quantity_before, quantity_after, notes, created_by
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `, [
                product_id,
                variant_id || null,
                adjustment_type,
                quantityChange,
                currentQuantity,
                newQuantity,
                notes || null,
                req.user.id
            ]);

            // Check for low stock and create alert if needed
            if (newQuantity <= product.min_stock_level) {
                // Check if alert already exists
                const existingAlert = await database.get(
                    'SELECT id FROM low_stock_alerts WHERE product_id = ? AND variant_id IS ? AND alert_status = "active"',
                    [product_id, variant_id || null]
                );

                if (!existingAlert) {
                    await database.run(`
                        INSERT INTO low_stock_alerts (product_id, variant_id, current_stock, min_stock_level)
                        VALUES (?, ?, ?, ?)
                    `, [product_id, variant_id || null, newQuantity, product.min_stock_level]);
                }
            } else {
                // Resolve existing low stock alert if quantity is now above minimum
                await database.run(
                    'UPDATE low_stock_alerts SET alert_status = "resolved" WHERE product_id = ? AND variant_id IS ? AND alert_status = "active"',
                    [product_id, variant_id || null]
                );
            }

            await database.commit();

            // Get updated stock info
            const updatedStock = await database.get(`
                SELECT 
                    p.name as product_name,
                    p.sku,
                    s.quantity,
                    s.reserved_quantity,
                    (s.quantity - s.reserved_quantity) as available_quantity,
                    CASE 
                        WHEN s.quantity <= p.min_stock_level THEN 1 
                        ELSE 0 
                    END as is_low_stock
                FROM stock s
                JOIN products p ON s.product_id = p.id
                WHERE s.product_id = ? AND s.variant_id IS ?
            `, [product_id, variant_id || null]);

            res.json({
                success: true,
                message: 'Stock adjusted successfully',
                data: {
                    stock: updatedStock,
                    adjustment: {
                        type: adjustment_type,
                        quantity_change: quantityChange,
                        previous_quantity: currentQuantity,
                        new_quantity: newQuantity
                    }
                }
            });

        } catch (error) {
            await database.rollback();
            throw error;
        }

    } catch (error) {
        console.error('Stock adjustment error:', error);
        res.status(500).json({
            success: false,
            message: 'Server error'
        });
    }
});

// Bulk stock adjustment
router.post('/bulk-adjust', [
    verifyToken,
    requireAdmin,
    body('adjustments').isArray({ min: 1 }).withMessage('Adjustments array is required'),
    body('adjustments.*.product_id').isInt().withMessage('Product ID is required'),
    body('adjustments.*.adjustment_type').isIn(['in', 'out', 'adjustment']).withMessage('Invalid adjustment type'),
    body('adjustments.*.quantity').isInt({ min: 0 }).withMessage('Quantity must be a non-negative integer'),
    body('notes').optional().trim()
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

        const { adjustments, notes } = req.body;
        const results = [];
        const failed = [];

        await database.beginTransaction();

        try {
            for (const adjustment of adjustments) {
                const { product_id, adjustment_type, quantity, variant_id } = adjustment;

                try {
                    // Check if product exists
                    const product = await database.get(
                        'SELECT * FROM products WHERE id = ? AND is_active = 1',
                        [product_id]
                    );

                    if (!product) {
                        failed.push({
                            product_id,
                            error: 'Product not found'
                        });
                        continue;
                    }

                    // Get current stock
                    const currentStock = await database.get(
                        'SELECT * FROM stock WHERE product_id = ? AND variant_id IS ?',
                        [product_id, variant_id || null]
                    );

                    if (!currentStock) {
                        failed.push({
                            product_id,
                            error: 'Stock record not found'
                        });
                        continue;
                    }

                    const currentQuantity = currentStock.quantity;
                    let newQuantity;

                    // Calculate new quantity
                    switch (adjustment_type) {
                        case 'in':
                            newQuantity = currentQuantity + quantity;
                            break;
                        case 'out':
                            newQuantity = Math.max(0, currentQuantity - quantity);
                            break;
                        case 'adjustment':
                            newQuantity = quantity;
                            break;
                    }

                    const quantityChange = newQuantity - currentQuantity;

                    // Update stock
                    await database.run(
                        'UPDATE stock SET quantity = ?, updated_by = ? WHERE product_id = ? AND variant_id IS ?',
                        [newQuantity, req.user.id, product_id, variant_id || null]
                    );

                    // Record stock movement
                    await database.run(`
                        INSERT INTO stock_movements (
                            product_id, variant_id, movement_type, quantity_change, 
                            quantity_before, quantity_after, notes, created_by
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    `, [
                        product_id,
                        variant_id || null,
                        adjustment_type,
                        quantityChange,
                        currentQuantity,
                        newQuantity,
                        notes || 'Bulk adjustment',
                        req.user.id
                    ]);

                    // Handle low stock alerts
                    if (newQuantity <= product.min_stock_level) {
                        const existingAlert = await database.get(
                            'SELECT id FROM low_stock_alerts WHERE product_id = ? AND variant_id IS ? AND alert_status = "active"',
                            [product_id, variant_id || null]
                        );

                        if (!existingAlert) {
                            await database.run(`
                                INSERT INTO low_stock_alerts (product_id, variant_id, current_stock, min_stock_level)
                                VALUES (?, ?, ?, ?)
                            `, [product_id, variant_id || null, newQuantity, product.min_stock_level]);
                        }
                    } else {
                        await database.run(
                            'UPDATE low_stock_alerts SET alert_status = "resolved" WHERE product_id = ? AND variant_id IS ? AND alert_status = "active"',
                            [product_id, variant_id || null]
                        );
                    }

                    results.push({
                        product_id,
                        product_name: product.name,
                        adjustment_type,
                        quantity_change: quantityChange,
                        previous_quantity: currentQuantity,
                        new_quantity: newQuantity,
                        success: true
                    });

                } catch (error) {
                    failed.push({
                        product_id,
                        error: error.message
                    });
                }
            }

            await database.commit();

            res.json({
                success: true,
                message: `Bulk adjustment completed. ${results.length} successful, ${failed.length} failed.`,
                data: {
                    successful: results,
                    failed: failed,
                    summary: {
                        total: adjustments.length,
                        successful: results.length,
                        failed: failed.length
                    }
                }
            });

        } catch (error) {
            await database.rollback();
            throw error;
        }

    } catch (error) {
        console.error('Bulk stock adjustment error:', error);
        res.status(500).json({
            success: false,
            message: 'Server error'
        });
    }
});

// Get low stock alerts
router.get('/alerts', verifyToken, requireStaff, async (req, res) => {
    try {
        const { status = 'active' } = req.query;

        const alerts = await database.query(`
            SELECT 
                lsa.*,
                p.name as product_name,
                p.sku,
                p.unit_size,
                c.name as category_name,
                pv.variant_name,
                pv.variant_value,
                u.first_name || ' ' || u.last_name as acknowledged_by_name
            FROM low_stock_alerts lsa
            JOIN products p ON lsa.product_id = p.id
            LEFT JOIN categories c ON p.category_id = c.id
            LEFT JOIN product_variants pv ON lsa.variant_id = pv.id
            LEFT JOIN users u ON lsa.acknowledged_by = u.id
            WHERE lsa.alert_status = ? AND p.is_active = 1
            ORDER BY lsa.created_at DESC
        `, [status]);

        res.json({
            success: true,
            data: { alerts }
        });

    } catch (error) {
        console.error('Get stock alerts error:', error);
        res.status(500).json({
            success: false,
            message: 'Server error'
        });
    }
});

// Acknowledge low stock alert
router.put('/alerts/:id/acknowledge', verifyToken, requireStaff, async (req, res) => {
    try {
        const { id } = req.params;

        const alert = await database.get(
            'SELECT * FROM low_stock_alerts WHERE id = ? AND alert_status = "active"',
            [id]
        );

        if (!alert) {
            return res.status(404).json({
                success: false,
                message: 'Alert not found or already acknowledged'
            });
        }

        await database.run(
            'UPDATE low_stock_alerts SET alert_status = "acknowledged", acknowledged_by = ?, acknowledged_at = CURRENT_TIMESTAMP WHERE id = ?',
            [req.user.id, id]
        );

        res.json({
            success: true,
            message: 'Alert acknowledged successfully'
        });

    } catch (error) {
        console.error('Acknowledge alert error:', error);
        res.status(500).json({
            success: false,
            message: 'Server error'
        });
    }
});

module.exports = router;