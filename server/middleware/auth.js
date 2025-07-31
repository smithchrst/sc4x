const jwt = require('jsonwebtoken');
const database = require('../config/database');

// Verify JWT token
const verifyToken = (req, res, next) => {
    const token = req.header('Authorization')?.replace('Bearer ', '');
    
    if (!token) {
        return res.status(401).json({ 
            success: false, 
            message: 'Access denied. No token provided.' 
        });
    }

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        req.user = decoded;
        next();
    } catch (error) {
        return res.status(400).json({ 
            success: false, 
            message: 'Invalid token.' 
        });
    }
};

// Check if user has required role
const requireRole = (roles) => {
    return async (req, res, next) => {
        try {
            // Get fresh user data from database
            const user = await database.get(
                'SELECT * FROM users WHERE id = ? AND is_active = 1',
                [req.user.id]
            );

            if (!user) {
                return res.status(401).json({
                    success: false,
                    message: 'User not found or inactive.'
                });
            }

            // Check if user has required role
            if (!roles.includes(user.role)) {
                return res.status(403).json({
                    success: false,
                    message: 'Access denied. Insufficient permissions.'
                });
            }

            // Update req.user with fresh data
            req.user = {
                id: user.id,
                username: user.username,
                email: user.email,
                role: user.role,
                first_name: user.first_name,
                last_name: user.last_name
            };

            next();
        } catch (error) {
            console.error('Role verification error:', error);
            return res.status(500).json({
                success: false,
                message: 'Server error during authorization.'
            });
        }
    };
};

// Admin only access
const requireAdmin = requireRole(['admin']);

// Admin or Cashier access
const requireStaff = requireRole(['admin', 'cashier']);

module.exports = {
    verifyToken,
    requireRole,
    requireAdmin,
    requireStaff
};