const express = require('express');
const { body, validationResult } = require('express-validator');
const database = require('../config/database');
const { verifyToken, requireAdmin, requireStaff } = require('../middleware/auth');

const router = express.Router();

// Get all sales with filtering and pagination
router.get('/', verifyToken, requireStaff, async (req, res) => {
    try {
        const {
            page = 1,
            limit = 20,
            date_from = '',
            date_to = '',
            cashier_id = '',
            status = '',
            search = ''
        } = req.query;

        const offset = (page - 1) * limit;
        let whereConditions = [];
        let queryParams = [];

        // Date range filter
        if (date_from) {
            whereConditions.push('DATE(s.created_at) >= ?');
            queryParams.push(date_from);
        }
        if (date_to) {
            whereConditions.push('DATE(s.created_at) <= ?');
            queryParams.push(date_to);
        }

        // Cashier filter
        if (cashier_id) {
            whereConditions.push('s.cashier_id = ?');
            queryParams.push(cashier_id);
        }

        // Status filter
        if (status) {
            whereConditions.push('s.status = ?');
            queryParams.push(status);
        }

        // Search filter
        if (search) {
            whereConditions.push('(s.sale_number LIKE ? OR s.customer_name LIKE ?)');
            const searchTerm = `%${search}%`;
            queryParams.push(searchTerm, searchTerm);
        }

        const whereClause = whereConditions.length > 0 ? 'WHERE ' + whereConditions.join(' AND ') : '';

        const salesQuery = `
            SELECT 
                s.*,
                u.first_name || ' ' || u.last_name as cashier_name,
                COUNT(si.id) as item_count
            FROM sales s
            LEFT JOIN users u ON s.cashier_id = u.id
            LEFT JOIN sale_items si ON s.id = si.sale_id
            ${whereClause}
            GROUP BY s.id
            ORDER BY s.created_at DESC
            LIMIT ? OFFSET ?
        `;

        const sales = await database.query(salesQuery, [...queryParams, parseInt(limit), offset]);

        // Get total count
        const countQuery = `
            SELECT COUNT(*) as total
            FROM sales s
            ${whereClause}
        `;
        const countResult = await database.get(countQuery, queryParams);

        // Get sales summary for the filtered period
        const summaryQuery = `
            SELECT 
                COUNT(*) as total_sales,
                SUM(total_amount) as total_revenue,
                AVG(total_amount) as average_sale,
                SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed_sales,
                SUM(CASE WHEN status = 'refunded' THEN 1 ELSE 0 END) as refunded_sales
            FROM sales s
            ${whereClause}
        `;
        const summary = await database.get(summaryQuery, queryParams);

        res.json({
            success: true,
            data: {
                sales,
                summary,
                pagination: {
                    current_page: parseInt(page),
                    per_page: parseInt(limit),
                    total: countResult.total,
                    total_pages: Math.ceil(countResult.total / limit)
                }
            }
        });

    } catch (error) {
        console.error('Get sales error:', error);
        res.status(500).json({
            success: false,
            message: 'Server error'
        });
    }
});

// Get sale by ID
router.get('/:id', verifyToken, requireStaff, async (req, res) => {
    try {
        const { id } = req.params;

        const sale = await database.get(`
            SELECT 
                s.*,
                u.first_name || ' ' || u.last_name as cashier_name
            FROM sales s
            LEFT JOIN users u ON s.cashier_id = u.id
            WHERE s.id = ?
        `, [id]);

        if (!sale) {
            return res.status(404).json({
                success: false,
                message: 'Sale not found'
            });
        }

        // Get sale items
        const items = await database.query(`
            SELECT 
                si.*,
                p.name as product_name,
                p.sku,
                p.unit_size,
                c.name as category_name,
                pv.variant_name,
                pv.variant_value
            FROM sale_items si
            JOIN products p ON si.product_id = p.id
            LEFT JOIN categories c ON p.category_id = c.id
            LEFT JOIN product_variants pv ON si.variant_id = pv.id
            WHERE si.sale_id = ?
            ORDER BY si.id
        `, [id]);

        res.json({
            success: true,
            data: {
                sale: {
                    ...sale,
                    items
                }
            }
        });

    } catch (error) {
        console.error('Get sale error:', error);
        res.status(500).json({
            success: false,
            message: 'Server error'
        });
    }
});

// Create new sale (POS)
router.post('/', [
    verifyToken,
    requireStaff,
    body('items').isArray({ min: 1 }).withMessage('Items array is required'),
    body('items.*.product_id').isInt().withMessage('Product ID is required'),
    body('items.*.quantity').isInt({ min: 1 }).withMessage('Quantity must be positive'),
    body('items.*.unit_price').isFloat({ min: 0 }).withMessage('Unit price must be positive'),
    body('payment_method').optional().trim(),
    body('customer_name').optional().trim(),
    body('discount_amount').optional().isFloat({ min: 0 }).withMessage('Discount must be non-negative'),
    body('tax_amount').optional().isFloat({ min: 0 }).withMessage('Tax must be non-negative'),
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

        const {
            items,
            payment_method = 'cash',
            customer_name,
            discount_amount = 0,
            tax_amount = 0,
            notes
        } = req.body;

        // Generate sale number
        const saleNumber = 'SALE-' + Date.now() + '-' + Math.random().toString(36).substr(2, 5).toUpperCase();

        await database.beginTransaction();

        try {
            // Validate all items and check stock availability
            const validatedItems = [];
            let subtotal = 0;

            for (const item of items) {
                const { product_id, variant_id, quantity, unit_price } = item;

                // Check product exists and is active
                const product = await database.get(
                    'SELECT * FROM products WHERE id = ? AND is_active = 1',
                    [product_id]
                );

                if (!product) {
                    throw new Error(`Product with ID ${product_id} not found`);
                }

                // Check stock availability
                const stock = await database.get(
                    'SELECT * FROM stock WHERE product_id = ? AND variant_id IS ?',
                    [product_id, variant_id || null]
                );

                if (!stock || stock.quantity < quantity) {
                    throw new Error(`Insufficient stock for ${product.name}. Available: ${stock ? stock.quantity : 0}, Required: ${quantity}`);
                }

                const totalPrice = quantity * unit_price;
                subtotal += totalPrice;

                validatedItems.push({
                    product_id,
                    variant_id: variant_id || null,
                    quantity,
                    unit_price,
                    total_price: totalPrice,
                    product: product,
                    current_stock: stock.quantity
                });
            }

            const totalAmount = subtotal - discount_amount + tax_amount;

            // Create sale record
            const saleResult = await database.run(`
                INSERT INTO sales (
                    sale_number, total_amount, tax_amount, discount_amount, 
                    payment_method, cashier_id, customer_name, notes
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `, [
                saleNumber,
                totalAmount,
                tax_amount,
                discount_amount,
                payment_method,
                req.user.id,
                customer_name || null,
                notes || null
            ]);

            const saleId = saleResult.id;

            // Create sale items and update stock
            for (const item of validatedItems) {
                // Create sale item
                await database.run(`
                    INSERT INTO sale_items (
                        sale_id, product_id, variant_id, quantity, 
                        unit_price, total_price, discount_amount
                    ) VALUES (?, ?, ?, ?, ?, ?, ?)
                `, [
                    saleId,
                    item.product_id,
                    item.variant_id,
                    item.quantity,
                    item.unit_price,
                    item.total_price,
                    0 // Individual item discount (can be implemented later)
                ]);

                // Update stock
                const newQuantity = item.current_stock - item.quantity;
                await database.run(
                    'UPDATE stock SET quantity = ?, updated_by = ? WHERE product_id = ? AND variant_id IS ?',
                    [newQuantity, req.user.id, item.product_id, item.variant_id]
                );

                // Record stock movement
                await database.run(`
                    INSERT INTO stock_movements (
                        product_id, variant_id, movement_type, quantity_change, 
                        quantity_before, quantity_after, reference_id, reference_type, 
                        notes, created_by
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `, [
                    item.product_id,
                    item.variant_id,
                    'sale',
                    -item.quantity,
                    item.current_stock,
                    newQuantity,
                    saleId,
                    'sale',
                    `Sale ${saleNumber}`,
                    req.user.id
                ]);

                // Check for low stock and create alert if needed
                if (newQuantity <= item.product.min_stock_level) {
                    const existingAlert = await database.get(
                        'SELECT id FROM low_stock_alerts WHERE product_id = ? AND variant_id IS ? AND alert_status = "active"',
                        [item.product_id, item.variant_id]
                    );

                    if (!existingAlert) {
                        await database.run(`
                            INSERT INTO low_stock_alerts (product_id, variant_id, current_stock, min_stock_level)
                            VALUES (?, ?, ?, ?)
                        `, [item.product_id, item.variant_id, newQuantity, item.product.min_stock_level]);
                    }
                }
            }

            await database.commit();

            // Get created sale with details
            const createdSale = await database.get(`
                SELECT 
                    s.*,
                    u.first_name || ' ' || u.last_name as cashier_name
                FROM sales s
                LEFT JOIN users u ON s.cashier_id = u.id
                WHERE s.id = ?
            `, [saleId]);

            const saleItems = await database.query(`
                SELECT 
                    si.*,
                    p.name as product_name,
                    p.sku,
                    pv.variant_name,
                    pv.variant_value
                FROM sale_items si
                JOIN products p ON si.product_id = p.id
                LEFT JOIN product_variants pv ON si.variant_id = pv.id
                WHERE si.sale_id = ?
            `, [saleId]);

            res.status(201).json({
                success: true,
                message: 'Sale completed successfully',
                data: {
                    sale: {
                        ...createdSale,
                        items: saleItems
                    }
                }
            });

        } catch (error) {
            await database.rollback();
            throw error;
        }

    } catch (error) {
        console.error('Create sale error:', error);
        res.status(400).json({
            success: false,
            message: error.message || 'Server error'
        });
    }
});

// Refund sale
router.post('/:id/refund', [
    verifyToken,
    requireAdmin,
    body('reason').optional().trim(),
    body('partial_items').optional().isArray()
], async (req, res) => {
    try {
        const { id } = req.params;
        const { reason, partial_items } = req.body;

        // Get sale details
        const sale = await database.get(
            'SELECT * FROM sales WHERE id = ? AND status = "completed"',
            [id]
        );

        if (!sale) {
            return res.status(404).json({
                success: false,
                message: 'Sale not found or already refunded'
            });
        }

        // Get sale items
        const saleItems = await database.query(
            'SELECT * FROM sale_items WHERE sale_id = ?',
            [id]
        );

        await database.beginTransaction();

        try {
            let itemsToRefund = saleItems;

            // If partial refund, filter items
            if (partial_items && partial_items.length > 0) {
                itemsToRefund = saleItems.filter(item => 
                    partial_items.some(partialItem => 
                        partialItem.sale_item_id === item.id
                    )
                );
            }

            // Restore stock for refunded items
            for (const item of itemsToRefund) {
                // Get current stock
                const currentStock = await database.get(
                    'SELECT * FROM stock WHERE product_id = ? AND variant_id IS ?',
                    [item.product_id, item.variant_id]
                );

                if (currentStock) {
                    const newQuantity = currentStock.quantity + item.quantity;
                    
                    // Update stock
                    await database.run(
                        'UPDATE stock SET quantity = ?, updated_by = ? WHERE product_id = ? AND variant_id IS ?',
                        [newQuantity, req.user.id, item.product_id, item.variant_id]
                    );

                    // Record stock movement
                    await database.run(`
                        INSERT INTO stock_movements (
                            product_id, variant_id, movement_type, quantity_change, 
                            quantity_before, quantity_after, reference_id, reference_type, 
                            notes, created_by
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    `, [
                        item.product_id,
                        item.variant_id,
                        'return',
                        item.quantity,
                        currentStock.quantity,
                        newQuantity,
                        id,
                        'refund',
                        `Refund for sale ${sale.sale_number}${reason ? ': ' + reason : ''}`,
                        req.user.id
                    ]);
                }
            }

            // Update sale status
            const isFullRefund = itemsToRefund.length === saleItems.length;
            await database.run(
                'UPDATE sales SET status = ?, notes = ? WHERE id = ?',
                [
                    isFullRefund ? 'refunded' : 'completed',
                    (sale.notes || '') + `\nRefund: ${reason || 'No reason provided'}`,
                    id
                ]
            );

            await database.commit();

            res.json({
                success: true,
                message: `${isFullRefund ? 'Full' : 'Partial'} refund processed successfully`,
                data: {
                    refund_type: isFullRefund ? 'full' : 'partial',
                    refunded_items: itemsToRefund.length,
                    total_items: saleItems.length
                }
            });

        } catch (error) {
            await database.rollback();
            throw error;
        }

    } catch (error) {
        console.error('Refund sale error:', error);
        res.status(500).json({
            success: false,
            message: 'Server error'
        });
    }
});

// Get sales analytics
router.get('/analytics/summary', verifyToken, requireStaff, async (req, res) => {
    try {
        const {
            period = 'today', // today, week, month, year, custom
            date_from = '',
            date_to = ''
        } = req.query;

        let dateCondition = '';
        let dateParams = [];

        switch (period) {
            case 'today':
                dateCondition = 'DATE(s.created_at) = DATE("now")';
                break;
            case 'week':
                dateCondition = 'DATE(s.created_at) >= DATE("now", "-7 days")';
                break;
            case 'month':
                dateCondition = 'DATE(s.created_at) >= DATE("now", "-30 days")';
                break;
            case 'year':
                dateCondition = 'DATE(s.created_at) >= DATE("now", "-365 days")';
                break;
            case 'custom':
                if (date_from && date_to) {
                    dateCondition = 'DATE(s.created_at) BETWEEN ? AND ?';
                    dateParams = [date_from, date_to];
                }
                break;
        }

        const whereClause = dateCondition ? `WHERE ${dateCondition}` : '';

        // Get sales summary
        const summary = await database.get(`
            SELECT 
                COUNT(*) as total_sales,
                SUM(CASE WHEN status = 'completed' THEN total_amount ELSE 0 END) as total_revenue,
                AVG(CASE WHEN status = 'completed' THEN total_amount ELSE NULL END) as average_sale,
                SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed_sales,
                SUM(CASE WHEN status = 'refunded' THEN 1 ELSE 0 END) as refunded_sales,
                SUM(CASE WHEN status = 'refunded' THEN total_amount ELSE 0 END) as refunded_amount
            FROM sales s
            ${whereClause}
        `, dateParams);

        // Get top selling products
        const topProducts = await database.query(`
            SELECT 
                p.id,
                p.name,
                p.sku,
                SUM(si.quantity) as total_sold,
                SUM(si.total_price) as total_revenue
            FROM sale_items si
            JOIN sales s ON si.sale_id = s.id
            JOIN products p ON si.product_id = p.id
            ${whereClause ? whereClause.replace('s.created_at', 's.created_at') : ''}
            AND s.status = 'completed'
            GROUP BY p.id, p.name, p.sku
            ORDER BY total_sold DESC
            LIMIT 10
        `, dateParams);

        // Get sales by payment method
        const paymentMethods = await database.query(`
            SELECT 
                payment_method,
                COUNT(*) as count,
                SUM(total_amount) as total_amount
            FROM sales s
            ${whereClause}
            AND status = 'completed'
            GROUP BY payment_method
            ORDER BY total_amount DESC
        `, dateParams);

        // Get hourly sales (for today only)
        let hourlySales = [];
        if (period === 'today') {
            hourlySales = await database.query(`
                SELECT 
                    strftime('%H', created_at) as hour,
                    COUNT(*) as sales_count,
                    SUM(total_amount) as total_amount
                FROM sales
                WHERE DATE(created_at) = DATE('now') AND status = 'completed'
                GROUP BY strftime('%H', created_at)
                ORDER BY hour
            `);
        }

        res.json({
            success: true,
            data: {
                summary: {
                    ...summary,
                    net_revenue: summary.total_revenue - summary.refunded_amount
                },
                top_products: topProducts,
                payment_methods: paymentMethods,
                hourly_sales: hourlySales,
                period: period,
                date_range: period === 'custom' ? { from: date_from, to: date_to } : null
            }
        });

    } catch (error) {
        console.error('Get sales analytics error:', error);
        res.status(500).json({
            success: false,
            message: 'Server error'
        });
    }
});

// Get recent sales activity
router.get('/recent', verifyToken, requireStaff, async (req, res) => {
    try {
        const { limit = 10 } = req.query;

        const recentSales = await database.query(`
            SELECT 
                s.id,
                s.sale_number,
                s.total_amount,
                s.payment_method,
                s.status,
                s.created_at,
                u.first_name || ' ' || u.last_name as cashier_name,
                COUNT(si.id) as item_count
            FROM sales s
            LEFT JOIN users u ON s.cashier_id = u.id
            LEFT JOIN sale_items si ON s.id = si.sale_id
            GROUP BY s.id
            ORDER BY s.created_at DESC
            LIMIT ?
        `, [parseInt(limit)]);

        res.json({
            success: true,
            data: { recent_sales: recentSales }
        });

    } catch (error) {
        console.error('Get recent sales error:', error);
        res.status(500).json({
            success: false,
            message: 'Server error'
        });
    }
});

module.exports = router;