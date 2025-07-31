const express = require('express');
const bcrypt = require('bcryptjs');
const { body, validationResult } = require('express-validator');
const database = require('../config/database');
const { verifyToken, requireAdmin } = require('../middleware/auth');

const router = express.Router();

// Get all users
router.get('/', verifyToken, requireAdmin, async (req, res) => {
    try {
        const users = await database.query(`
            SELECT 
                id, username, email, role, first_name, last_name, 
                is_active, created_at, updated_at
            FROM users
            ORDER BY created_at DESC
        `);

        res.json({
            success: true,
            data: { users }
        });

    } catch (error) {
        console.error('Get users error:', error);
        res.status(500).json({
            success: false,
            message: 'Server error'
        });
    }
});

// Get user by ID
router.get('/:id', verifyToken, requireAdmin, async (req, res) => {
    try {
        const { id } = req.params;

        const user = await database.get(`
            SELECT 
                id, username, email, role, first_name, last_name, 
                is_active, created_at, updated_at
            FROM users
            WHERE id = ?
        `, [id]);

        if (!user) {
            return res.status(404).json({
                success: false,
                message: 'User not found'
            });
        }

        res.json({
            success: true,
            data: { user }
        });

    } catch (error) {
        console.error('Get user error:', error);
        res.status(500).json({
            success: false,
            message: 'Server error'
        });
    }
});

// Create new user
router.post('/', [
    verifyToken,
    requireAdmin,
    body('username').notEmpty().trim().isLength({ min: 3 }).withMessage('Username must be at least 3 characters'),
    body('email').isEmail().normalizeEmail().withMessage('Valid email is required'),
    body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
    body('role').isIn(['admin', 'cashier']).withMessage('Role must be admin or cashier'),
    body('first_name').notEmpty().trim().withMessage('First name is required'),
    body('last_name').notEmpty().trim().withMessage('Last name is required')
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

        const { username, email, password, role, first_name, last_name } = req.body;

        // Check if username already exists
        const existingUsername = await database.get(
            'SELECT id FROM users WHERE username = ?',
            [username]
        );

        if (existingUsername) {
            return res.status(400).json({
                success: false,
                message: 'Username already exists'
            });
        }

        // Check if email already exists
        const existingEmail = await database.get(
            'SELECT id FROM users WHERE email = ?',
            [email]
        );

        if (existingEmail) {
            return res.status(400).json({
                success: false,
                message: 'Email already exists'
            });
        }

        // Hash password
        const hashedPassword = await bcrypt.hash(password, 10);

        // Create user
        const result = await database.run(`
            INSERT INTO users (username, email, password_hash, role, first_name, last_name)
            VALUES (?, ?, ?, ?, ?, ?)
        `, [username, email, hashedPassword, role, first_name, last_name]);

        // Get created user (without password)
        const newUser = await database.get(`
            SELECT 
                id, username, email, role, first_name, last_name, 
                is_active, created_at
            FROM users
            WHERE id = ?
        `, [result.id]);

        res.status(201).json({
            success: true,
            message: 'User created successfully',
            data: { user: newUser }
        });

    } catch (error) {
        console.error('Create user error:', error);
        res.status(500).json({
            success: false,
            message: 'Server error'
        });
    }
});

// Update user
router.put('/:id', [
    verifyToken,
    requireAdmin,
    body('username').optional().trim().isLength({ min: 3 }).withMessage('Username must be at least 3 characters'),
    body('email').optional().isEmail().normalizeEmail().withMessage('Valid email is required'),
    body('role').optional().isIn(['admin', 'cashier']).withMessage('Role must be admin or cashier'),
    body('first_name').optional().trim().notEmpty().withMessage('First name cannot be empty'),
    body('last_name').optional().trim().notEmpty().withMessage('Last name cannot be empty'),
    body('is_active').optional().isBoolean().withMessage('is_active must be boolean')
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
        const { username, email, role, first_name, last_name, is_active } = req.body;

        // Check if user exists
        const existingUser = await database.get(
            'SELECT * FROM users WHERE id = ?',
            [id]
        );

        if (!existingUser) {
            return res.status(404).json({
                success: false,
                message: 'User not found'
            });
        }

        // Prevent user from deactivating themselves
        if (req.user.id == id && is_active === false) {
            return res.status(400).json({
                success: false,
                message: 'You cannot deactivate your own account'
            });
        }

        // Check if username already exists (excluding current user)
        if (username && username !== existingUser.username) {
            const existingUsername = await database.get(
                'SELECT id FROM users WHERE username = ? AND id != ?',
                [username, id]
            );

            if (existingUsername) {
                return res.status(400).json({
                    success: false,
                    message: 'Username already exists'
                });
            }
        }

        // Check if email already exists (excluding current user)
        if (email && email !== existingUser.email) {
            const existingEmail = await database.get(
                'SELECT id FROM users WHERE email = ? AND id != ?',
                [email, id]
            );

            if (existingEmail) {
                return res.status(400).json({
                    success: false,
                    message: 'Email already exists'
                });
            }
        }

        // Build update query dynamically
        const updateFields = [];
        const updateValues = [];

        if (username !== undefined) {
            updateFields.push('username = ?');
            updateValues.push(username);
        }
        if (email !== undefined) {
            updateFields.push('email = ?');
            updateValues.push(email);
        }
        if (role !== undefined) {
            updateFields.push('role = ?');
            updateValues.push(role);
        }
        if (first_name !== undefined) {
            updateFields.push('first_name = ?');
            updateValues.push(first_name);
        }
        if (last_name !== undefined) {
            updateFields.push('last_name = ?');
            updateValues.push(last_name);
        }
        if (is_active !== undefined) {
            updateFields.push('is_active = ?');
            updateValues.push(is_active ? 1 : 0);
        }

        if (updateFields.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'No fields to update'
            });
        }

        updateValues.push(id);

        // Update user
        await database.run(
            `UPDATE users SET ${updateFields.join(', ')} WHERE id = ?`,
            updateValues
        );

        // Get updated user
        const updatedUser = await database.get(`
            SELECT 
                id, username, email, role, first_name, last_name, 
                is_active, created_at, updated_at
            FROM users
            WHERE id = ?
        `, [id]);

        res.json({
            success: true,
            message: 'User updated successfully',
            data: { user: updatedUser }
        });

    } catch (error) {
        console.error('Update user error:', error);
        res.status(500).json({
            success: false,
            message: 'Server error'
        });
    }
});

// Reset user password
router.post('/:id/reset-password', [
    verifyToken,
    requireAdmin,
    body('new_password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters')
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
        const { new_password } = req.body;

        // Check if user exists
        const user = await database.get(
            'SELECT id, username FROM users WHERE id = ?',
            [id]
        );

        if (!user) {
            return res.status(404).json({
                success: false,
                message: 'User not found'
            });
        }

        // Hash new password
        const hashedPassword = await bcrypt.hash(new_password, 10);

        // Update password
        await database.run(
            'UPDATE users SET password_hash = ? WHERE id = ?',
            [hashedPassword, id]
        );

        res.json({
            success: true,
            message: `Password reset successfully for user: ${user.username}`
        });

    } catch (error) {
        console.error('Reset password error:', error);
        res.status(500).json({
            success: false,
            message: 'Server error'
        });
    }
});

// Delete user (soft delete)
router.delete('/:id', verifyToken, requireAdmin, async (req, res) => {
    try {
        const { id } = req.params;

        // Check if user exists
        const user = await database.get(
            'SELECT * FROM users WHERE id = ?',
            [id]
        );

        if (!user) {
            return res.status(404).json({
                success: false,
                message: 'User not found'
            });
        }

        // Prevent user from deleting themselves
        if (req.user.id == id) {
            return res.status(400).json({
                success: false,
                message: 'You cannot delete your own account'
            });
        }

        // Check if user has sales records
        const salesCount = await database.get(
            'SELECT COUNT(*) as count FROM sales WHERE cashier_id = ?',
            [id]
        );

        if (salesCount.count > 0) {
            return res.status(400).json({
                success: false,
                message: `Cannot delete user. They have ${salesCount.count} sales records. You can deactivate the user instead.`
            });
        }

        // Soft delete user
        await database.run(
            'UPDATE users SET is_active = 0 WHERE id = ?',
            [id]
        );

        res.json({
            success: true,
            message: 'User deleted successfully'
        });

    } catch (error) {
        console.error('Delete user error:', error);
        res.status(500).json({
            success: false,
            message: 'Server error'
        });
    }
});

// Get user activity/stats
router.get('/:id/stats', verifyToken, requireAdmin, async (req, res) => {
    try {
        const { id } = req.params;

        // Check if user exists
        const user = await database.get(
            'SELECT id, username, first_name, last_name, role FROM users WHERE id = ?',
            [id]
        );

        if (!user) {
            return res.status(404).json({
                success: false,
                message: 'User not found'
            });
        }

        // Get sales statistics
        const salesStats = await database.get(`
            SELECT 
                COUNT(*) as total_sales,
                SUM(CASE WHEN status = 'completed' THEN total_amount ELSE 0 END) as total_revenue,
                AVG(CASE WHEN status = 'completed' THEN total_amount ELSE NULL END) as average_sale,
                MIN(created_at) as first_sale,
                MAX(created_at) as last_sale
            FROM sales
            WHERE cashier_id = ?
        `, [id]);

        // Get recent sales
        const recentSales = await database.query(`
            SELECT 
                id, sale_number, total_amount, status, created_at
            FROM sales
            WHERE cashier_id = ?
            ORDER BY created_at DESC
            LIMIT 10
        `, [id]);

        // Get stock movements created by user
        const stockMovements = await database.get(`
            SELECT 
                COUNT(*) as total_movements,
                MIN(created_at) as first_movement,
                MAX(created_at) as last_movement
            FROM stock_movements
            WHERE created_by = ?
        `, [id]);

        res.json({
            success: true,
            data: {
                user: user,
                sales_stats: salesStats,
                recent_sales: recentSales,
                stock_movements: stockMovements
            }
        });

    } catch (error) {
        console.error('Get user stats error:', error);
        res.status(500).json({
            success: false,
            message: 'Server error'
        });
    }
});

module.exports = router;