const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '../database/inventory.db');
const SCHEMA_PATH = path.join(__dirname, '../database/schema.sql');

// Ensure database directory exists
const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
}

// Initialize database
const db = new sqlite3.Database(DB_PATH, (err) => {
    if (err) {
        console.error('Error opening database:', err.message);
        process.exit(1);
    }
    console.log('Connected to SQLite database.');
});

// Function to run SQL from file
function runSQLFile(filePath) {
    return new Promise((resolve, reject) => {
        const sql = fs.readFileSync(filePath, 'utf8');
        db.exec(sql, (err) => {
            if (err) {
                reject(err);
            } else {
                resolve();
            }
        });
    });
}

// Function to create default admin user
function createDefaultAdmin() {
    return new Promise((resolve, reject) => {
        const defaultPassword = 'admin123';
        const hashedPassword = bcrypt.hashSync(defaultPassword, 10);
        
        const sql = `
            INSERT OR IGNORE INTO users (username, email, password_hash, role, first_name, last_name)
            VALUES (?, ?, ?, ?, ?, ?)
        `;
        
        db.run(sql, [
            'admin',
            'admin@retailstore.com',
            hashedPassword,
            'admin',
            'System',
            'Administrator'
        ], function(err) {
            if (err) {
                reject(err);
            } else {
                console.log('Default admin user created (username: admin, password: admin123)');
                resolve();
            }
        });
    });
}

// Function to create sample cashier user
function createSampleCashier() {
    return new Promise((resolve, reject) => {
        const defaultPassword = 'cashier123';
        const hashedPassword = bcrypt.hashSync(defaultPassword, 10);
        
        const sql = `
            INSERT OR IGNORE INTO users (username, email, password_hash, role, first_name, last_name)
            VALUES (?, ?, ?, ?, ?, ?)
        `;
        
        db.run(sql, [
            'cashier',
            'cashier@retailstore.com',
            hashedPassword,
            'cashier',
            'John',
            'Cashier'
        ], function(err) {
            if (err) {
                reject(err);
            } else {
                console.log('Sample cashier user created (username: cashier, password: cashier123)');
                resolve();
            }
        });
    });
}

// Function to create sample categories
function createSampleCategories() {
    return new Promise((resolve, reject) => {
        const categories = [
            { name: 'Beverages', description: 'All types of drinks' },
            { name: 'Snacks', description: 'Chips, crackers, and snack foods' },
            { name: 'Dairy', description: 'Milk, cheese, yogurt products' },
            { name: 'Household', description: 'Cleaning supplies and household items' },
            { name: 'Personal Care', description: 'Health and beauty products' }
        ];
        
        let completed = 0;
        categories.forEach((category, index) => {
            const sql = `
                INSERT OR IGNORE INTO categories (name, description)
                VALUES (?, ?)
            `;
            
            db.run(sql, [category.name, category.description], function(err) {
                if (err) {
                    reject(err);
                    return;
                }
                completed++;
                if (completed === categories.length) {
                    console.log('Sample categories created');
                    
                    // Create subcategories
                    const subcategories = [
                        { name: 'Bottled Water', parent: 'Beverages' },
                        { name: 'Soft Drinks', parent: 'Beverages' },
                        { name: 'Potato Chips', parent: 'Snacks' },
                        { name: 'Cookies', parent: 'Snacks' }
                    ];
                    
                    let subCompleted = 0;
                    subcategories.forEach(subcat => {
                        // First get parent ID
                        db.get('SELECT id FROM categories WHERE name = ?', [subcat.parent], (err, row) => {
                            if (err || !row) {
                                subCompleted++;
                                if (subCompleted === subcategories.length) resolve();
                                return;
                            }
                            
                            const subSql = `
                                INSERT OR IGNORE INTO categories (name, parent_id)
                                VALUES (?, ?)
                            `;
                            
                            db.run(subSql, [subcat.name, row.id], (err) => {
                                subCompleted++;
                                if (subCompleted === subcategories.length) {
                                    console.log('Sample subcategories created');
                                    resolve();
                                }
                            });
                        });
                    });
                }
            });
        });
    });
}

// Function to create sample products
function createSampleProducts() {
    return new Promise((resolve, reject) => {
        const products = [
            {
                sku: 'BEV001',
                barcode: '1234567890123',
                name: 'Premium Bottled Water 500ml',
                category: 'Bottled Water',
                brand: 'AquaPure',
                price: 1.50,
                cost: 0.75,
                min_stock_level: 50,
                stock: 100
            },
            {
                sku: 'BEV002',
                barcode: '1234567890124',
                name: 'Cola Classic 330ml',
                category: 'Soft Drinks',
                brand: 'RefreshCo',
                price: 2.25,
                cost: 1.20,
                min_stock_level: 30,
                stock: 75
            },
            {
                sku: 'SNK001',
                barcode: '1234567890125',
                name: 'Original Potato Chips 150g',
                category: 'Potato Chips',
                brand: 'CrunchyBite',
                price: 3.99,
                cost: 2.10,
                min_stock_level: 20,
                stock: 45
            },
            {
                sku: 'SNK002',
                barcode: '1234567890126',
                name: 'Chocolate Chip Cookies 200g',
                category: 'Cookies',
                brand: 'SweetTreats',
                price: 4.50,
                cost: 2.25,
                min_stock_level: 15,
                stock: 8  // This will trigger low stock alert
            },
            {
                sku: 'DAI001',
                barcode: '1234567890127',
                name: 'Fresh Milk 1L',
                category: 'Dairy',
                brand: 'FarmFresh',
                price: 3.25,
                cost: 1.80,
                min_stock_level: 25,
                stock: 35
            }
        ];
        
        let completed = 0;
        products.forEach(product => {
            // First get category ID
            db.get('SELECT id FROM categories WHERE name = ?', [product.category], (err, row) => {
                if (err) {
                    console.error('Error finding category:', err);
                    completed++;
                    if (completed === products.length) resolve();
                    return;
                }
                
                const categoryId = row ? row.id : null;
                
                const sql = `
                    INSERT OR IGNORE INTO products (sku, barcode, name, category_id, brand, price, cost, min_stock_level)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                `;
                
                db.run(sql, [
                    product.sku,
                    product.barcode,
                    product.name,
                    categoryId,
                    product.brand,
                    product.price,
                    product.cost,
                    product.min_stock_level
                ], function(err) {
                    if (err) {
                        console.error('Error creating product:', err);
                    } else {
                        // Create stock entry
                        const stockSql = `
                            INSERT OR IGNORE INTO stock (product_id, quantity)
                            VALUES (?, ?)
                        `;
                        
                        db.run(stockSql, [this.lastID, product.stock], (err) => {
                            if (err) {
                                console.error('Error creating stock:', err);
                            }
                        });
                    }
                    
                    completed++;
                    if (completed === products.length) {
                        console.log('Sample products and stock created');
                        resolve();
                    }
                });
            });
        });
    });
}

// Main initialization function
async function initializeDatabase() {
    try {
        console.log('Initializing database...');
        
        // Create tables
        await runSQLFile(SCHEMA_PATH);
        console.log('Database schema created');
        
        // Create default users
        await createDefaultAdmin();
        await createSampleCashier();
        
        // Create sample data
        await createSampleCategories();
        await createSampleProducts();
        
        console.log('Database initialization completed successfully!');
        console.log('\nDefault login credentials:');
        console.log('Admin - Username: admin, Password: admin123');
        console.log('Cashier - Username: cashier, Password: cashier123');
        
    } catch (error) {
        console.error('Error initializing database:', error);
        process.exit(1);
    } finally {
        db.close((err) => {
            if (err) {
                console.error('Error closing database:', err.message);
            } else {
                console.log('Database connection closed.');
            }
        });
    }
}

// Run initialization
initializeDatabase();