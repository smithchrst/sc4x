const express = require('express');
const database = require('../config/database');
const { verifyToken, requireStaff } = require('../middleware/auth');

const router = express.Router();

// Get dashboard overview
router.get('/overview', verifyToken, requireStaff, async (req, res) => {
    try {
        // Get today's sales summary
        const todaySales = await database.get(`
            SELECT 
                COUNT(*) as total_sales,
                SUM(CASE WHEN status = 'completed' THEN total_amount ELSE 0 END) as total_revenue,
                AVG(CASE WHEN status = 'completed' THEN total_amount ELSE NULL END) as average_sale
            FROM sales
            WHERE DATE(created_at) = DATE('now')
        `);

        // Get this week's sales summary
        const weekSales = await database.get(`
            SELECT 
                COUNT(*) as total_sales,
                SUM(CASE WHEN status = 'completed' THEN total_amount ELSE 0 END) as total_revenue
            FROM sales
            WHERE DATE(created_at) >= DATE('now', '-7 days')
        `);

        // Get this month's sales summary
        const monthSales = await database.get(`
            SELECT 
                COUNT(*) as total_sales,
                SUM(CASE WHEN status = 'completed' THEN total_amount ELSE 0 END) as total_revenue
            FROM sales
            WHERE DATE(created_at) >= DATE('now', '-30 days')
        `);

        // Get low stock count
        const lowStockCount = await database.get(`
            SELECT COUNT(*) as count
            FROM products p
            LEFT JOIN stock s ON p.id = s.product_id AND s.variant_id IS NULL
            WHERE p.is_active = 1 AND s.quantity <= p.min_stock_level
        `);

        // Get out of stock count
        const outOfStockCount = await database.get(`
            SELECT COUNT(*) as count
            FROM products p
            LEFT JOIN stock s ON p.id = s.product_id AND s.variant_id IS NULL
            WHERE p.is_active = 1 AND s.quantity = 0
        `);

        // Get total products count
        const totalProducts = await database.get(`
            SELECT COUNT(*) as count
            FROM products
            WHERE is_active = 1
        `);

        // Get total categories count
        const totalCategories = await database.get(`
            SELECT COUNT(*) as count
            FROM categories
            WHERE is_active = 1
        `);

        // Get active users count
        const activeUsers = await database.get(`
            SELECT COUNT(*) as count
            FROM users
            WHERE is_active = 1
        `);

        // Get pending low stock alerts
        const pendingAlerts = await database.get(`
            SELECT COUNT(*) as count
            FROM low_stock_alerts
            WHERE alert_status = 'active'
        `);

        res.json({
            success: true,
            data: {
                sales: {
                    today: {
                        count: todaySales.total_sales || 0,
                        revenue: todaySales.total_revenue || 0,
                        average: todaySales.average_sale || 0
                    },
                    week: {
                        count: weekSales.total_sales || 0,
                        revenue: weekSales.total_revenue || 0
                    },
                    month: {
                        count: monthSales.total_sales || 0,
                        revenue: monthSales.total_revenue || 0
                    }
                },
                inventory: {
                    total_products: totalProducts.count || 0,
                    low_stock: lowStockCount.count || 0,
                    out_of_stock: outOfStockCount.count || 0,
                    total_categories: totalCategories.count || 0
                },
                system: {
                    active_users: activeUsers.count || 0,
                    pending_alerts: pendingAlerts.count || 0
                }
            }
        });

    } catch (error) {
        console.error('Dashboard overview error:', error);
        res.status(500).json({
            success: false,
            message: 'Server error'
        });
    }
});

// Get recent activity
router.get('/recent-activity', verifyToken, requireStaff, async (req, res) => {
    try {
        // Get recent sales
        const recentSales = await database.query(`
            SELECT 
                s.id,
                s.sale_number,
                s.total_amount,
                s.status,
                s.created_at,
                u.first_name || ' ' || u.last_name as cashier_name
            FROM sales s
            LEFT JOIN users u ON s.cashier_id = u.id
            ORDER BY s.created_at DESC
            LIMIT 5
        `);

        // Get recent stock movements
        const recentMovements = await database.query(`
            SELECT 
                sm.id,
                sm.movement_type,
                sm.quantity_change,
                sm.created_at,
                p.name as product_name,
                p.sku,
                u.first_name || ' ' || u.last_name as created_by_name
            FROM stock_movements sm
            LEFT JOIN products p ON sm.product_id = p.id
            LEFT JOIN users u ON sm.created_by = u.id
            ORDER BY sm.created_at DESC
            LIMIT 5
        `);

        // Get recent low stock alerts
        const recentAlerts = await database.query(`
            SELECT 
                lsa.id,
                lsa.current_stock,
                lsa.min_stock_level,
                lsa.created_at,
                p.name as product_name,
                p.sku
            FROM low_stock_alerts lsa
            JOIN products p ON lsa.product_id = p.id
            WHERE lsa.alert_status = 'active'
            ORDER BY lsa.created_at DESC
            LIMIT 5
        `);

        res.json({
            success: true,
            data: {
                recent_sales: recentSales,
                recent_movements: recentMovements,
                recent_alerts: recentAlerts
            }
        });

    } catch (error) {
        console.error('Recent activity error:', error);
        res.status(500).json({
            success: false,
            message: 'Server error'
        });
    }
});

// Get top selling products
router.get('/top-products', verifyToken, requireStaff, async (req, res) => {
    try {
        const { period = 'week', limit = 10 } = req.query;

        let dateCondition = '';
        switch (period) {
            case 'today':
                dateCondition = 'AND DATE(s.created_at) = DATE("now")';
                break;
            case 'week':
                dateCondition = 'AND DATE(s.created_at) >= DATE("now", "-7 days")';
                break;
            case 'month':
                dateCondition = 'AND DATE(s.created_at) >= DATE("now", "-30 days")';
                break;
            case 'year':
                dateCondition = 'AND DATE(s.created_at) >= DATE("now", "-365 days")';
                break;
        }

        const topProducts = await database.query(`
            SELECT 
                p.id,
                p.name,
                p.sku,
                p.price,
                c.name as category_name,
                SUM(si.quantity) as total_sold,
                SUM(si.total_price) as total_revenue,
                COUNT(DISTINCT s.id) as sale_count
            FROM sale_items si
            JOIN sales s ON si.sale_id = s.id
            JOIN products p ON si.product_id = p.id
            LEFT JOIN categories c ON p.category_id = c.id
            WHERE s.status = 'completed' ${dateCondition}
            GROUP BY p.id, p.name, p.sku, p.price, c.name
            ORDER BY total_sold DESC
            LIMIT ?
        `, [parseInt(limit)]);

        res.json({
            success: true,
            data: {
                top_products: topProducts,
                period: period
            }
        });

    } catch (error) {
        console.error('Top products error:', error);
        res.status(500).json({
            success: false,
            message: 'Server error'
        });
    }
});

// Get sales chart data
router.get('/sales-chart', verifyToken, requireStaff, async (req, res) => {
    try {
        const { period = 'week' } = req.query;

        let chartData = [];
        let dateFormat = '';
        let dateRange = '';

        switch (period) {
            case 'today':
                dateFormat = '%H:00';
                dateRange = 'DATE(created_at) = DATE("now")';
                // Generate hourly data for today
                for (let hour = 0; hour < 24; hour++) {
                    chartData.push({
                        label: `${hour.toString().padStart(2, '0')}:00`,
                        sales: 0,
                        revenue: 0
                    });
                }
                break;
            case 'week':
                dateFormat = '%Y-%m-%d';
                dateRange = 'DATE(created_at) >= DATE("now", "-7 days")';
                // Generate daily data for last 7 days
                for (let i = 6; i >= 0; i--) {
                    const date = new Date();
                    date.setDate(date.getDate() - i);
                    chartData.push({
                        label: date.toISOString().split('T')[0],
                        sales: 0,
                        revenue: 0
                    });
                }
                break;
            case 'month':
                dateFormat = '%Y-%m-%d';
                dateRange = 'DATE(created_at) >= DATE("now", "-30 days")';
                // Generate daily data for last 30 days
                for (let i = 29; i >= 0; i--) {
                    const date = new Date();
                    date.setDate(date.getDate() - i);
                    chartData.push({
                        label: date.toISOString().split('T')[0],
                        sales: 0,
                        revenue: 0
                    });
                }
                break;
        }

        // Get actual sales data
        const salesData = await database.query(`
            SELECT 
                strftime('${dateFormat}', created_at) as period_label,
                COUNT(*) as sales_count,
                SUM(CASE WHEN status = 'completed' THEN total_amount ELSE 0 END) as revenue
            FROM sales
            WHERE ${dateRange}
            GROUP BY strftime('${dateFormat}', created_at)
            ORDER BY period_label
        `);

        // Merge actual data with chart template
        salesData.forEach(data => {
            const chartItem = chartData.find(item => {
                if (period === 'today') {
                    return item.label === data.period_label;
                } else {
                    return item.label === data.period_label;
                }
            });
            if (chartItem) {
                chartItem.sales = data.sales_count;
                chartItem.revenue = data.revenue;
            }
        });

        res.json({
            success: true,
            data: {
                chart_data: chartData,
                period: period
            }
        });

    } catch (error) {
        console.error('Sales chart error:', error);
        res.status(500).json({
            success: false,
            message: 'Server error'
        });
    }
});

// Get inventory status summary
router.get('/inventory-status', verifyToken, requireStaff, async (req, res) => {
    try {
        // Get inventory status by category
        const inventoryByCategory = await database.query(`
            SELECT 
                c.name as category_name,
                COUNT(p.id) as total_products,
                SUM(CASE WHEN s.quantity <= p.min_stock_level THEN 1 ELSE 0 END) as low_stock_count,
                SUM(CASE WHEN s.quantity = 0 THEN 1 ELSE 0 END) as out_of_stock_count,
                SUM(s.quantity) as total_quantity,
                SUM(s.quantity * p.price) as total_value
            FROM categories c
            LEFT JOIN products p ON c.id = p.category_id AND p.is_active = 1
            LEFT JOIN stock s ON p.id = s.product_id AND s.variant_id IS NULL
            WHERE c.is_active = 1 AND c.parent_id IS NULL
            GROUP BY c.id, c.name
            ORDER BY c.name
        `);

        // Get stock status distribution
        const stockDistribution = await database.get(`
            SELECT 
                SUM(CASE WHEN s.quantity = 0 THEN 1 ELSE 0 END) as out_of_stock,
                SUM(CASE WHEN s.quantity > 0 AND s.quantity <= p.min_stock_level THEN 1 ELSE 0 END) as low_stock,
                SUM(CASE WHEN s.quantity > p.min_stock_level THEN 1 ELSE 0 END) as in_stock
            FROM products p
            LEFT JOIN stock s ON p.id = s.product_id AND s.variant_id IS NULL
            WHERE p.is_active = 1
        `);

        // Get total inventory value
        const inventoryValue = await database.get(`
            SELECT 
                SUM(s.quantity * p.cost) as total_cost_value,
                SUM(s.quantity * p.price) as total_retail_value,
                COUNT(p.id) as total_products
            FROM products p
            LEFT JOIN stock s ON p.id = s.product_id AND s.variant_id IS NULL
            WHERE p.is_active = 1
        `);

        res.json({
            success: true,
            data: {
                by_category: inventoryByCategory,
                stock_distribution: stockDistribution,
                inventory_value: inventoryValue
            }
        });

    } catch (error) {
        console.error('Inventory status error:', error);
        res.status(500).json({
            success: false,
            message: 'Server error'
        });
    }
});

// Get low stock products for dashboard
router.get('/low-stock-products', verifyToken, requireStaff, async (req, res) => {
    try {
        const { limit = 10 } = req.query;

        const lowStockProducts = await database.query(`
            SELECT 
                p.id,
                p.name,
                p.sku,
                p.min_stock_level,
                s.quantity,
                c.name as category_name,
                CASE 
                    WHEN s.quantity = 0 THEN 'out_of_stock'
                    WHEN s.quantity <= p.min_stock_level THEN 'low_stock'
                    ELSE 'in_stock'
                END as stock_status
            FROM products p
            LEFT JOIN stock s ON p.id = s.product_id AND s.variant_id IS NULL
            LEFT JOIN categories c ON p.category_id = c.id
            WHERE p.is_active = 1 AND s.quantity <= p.min_stock_level
            ORDER BY s.quantity ASC, p.name ASC
            LIMIT ?
        `, [parseInt(limit)]);

        res.json({
            success: true,
            data: {
                low_stock_products: lowStockProducts
            }
        });

    } catch (error) {
        console.error('Low stock products error:', error);
        res.status(500).json({
            success: false,
            message: 'Server error'
        });
    }
});

// Get cashier performance
router.get('/cashier-performance', verifyToken, requireStaff, async (req, res) => {
    try {
        const { period = 'month' } = req.query;

        let dateCondition = '';
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
        }

        const cashierPerformance = await database.query(`
            SELECT 
                u.id,
                u.first_name || ' ' || u.last_name as name,
                u.role,
                COUNT(s.id) as total_sales,
                SUM(CASE WHEN s.status = 'completed' THEN s.total_amount ELSE 0 END) as total_revenue,
                AVG(CASE WHEN s.status = 'completed' THEN s.total_amount ELSE NULL END) as average_sale,
                SUM(CASE WHEN s.status = 'refunded' THEN 1 ELSE 0 END) as refunded_sales
            FROM users u
            LEFT JOIN sales s ON u.id = s.cashier_id AND ${dateCondition}
            WHERE u.is_active = 1 AND u.role IN ('admin', 'cashier')
            GROUP BY u.id, u.first_name, u.last_name, u.role
            ORDER BY total_revenue DESC
        `);

        res.json({
            success: true,
            data: {
                cashier_performance: cashierPerformance,
                period: period
            }
        });

    } catch (error) {
        console.error('Cashier performance error:', error);
        res.status(500).json({
            success: false,
            message: 'Server error'
        });
    }
});

module.exports = router;