const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

/**
 * Database Initialization Script
 * Creates schema and seeds initial data if database is empty
 * Runs on application startup if database is empty
 */

const SCHEMA_SQL = `
-- Tables
CREATE TABLE TABLES (
    table_id INTEGER PRIMARY KEY AUTOINCREMENT,
    table_number TEXT NOT NULL,
    status TEXT NOT NULL
);

CREATE TABLE CATEGORIES (
    category_id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL
);

CREATE TABLE EMPLOYEES (
    employee_id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    role TEXT
);

CREATE TABLE SESSIONS (
    session_id INTEGER PRIMARY KEY AUTOINCREMENT,
    table_id INTEGER NOT NULL,
    status TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (table_id) REFERENCES TABLES(table_id) ON DELETE CASCADE
);

CREATE TABLE SESSION_USERS (
    user_id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    is_paid INTEGER DEFAULT 0,
    FOREIGN KEY (session_id) REFERENCES SESSIONS(session_id) ON DELETE CASCADE
);

CREATE TABLE MENU_ITEMS (
    menu_item_id INTEGER PRIMARY KEY AUTOINCREMENT,
    category_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    price NUMERIC NOT NULL,
    image_url TEXT,
    is_available BOOLEAN DEFAULT 1,
    FOREIGN KEY (category_id) REFERENCES CATEGORIES(category_id) ON DELETE CASCADE
);

CREATE TABLE ORDERS (
    order_id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL,
    status TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (session_id) REFERENCES SESSIONS(session_id) ON DELETE CASCADE
);

CREATE TABLE ORDER_ITEMS (
    order_item_id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL,
    menu_item_id INTEGER NOT NULL,
    updated_by_employee_id INTEGER,
    qty INTEGER NOT NULL DEFAULT 1,
    note TEXT,
    status TEXT NOT NULL,
    sent_at DATETIME,
    FOREIGN KEY (order_id) REFERENCES ORDERS(order_id) ON DELETE CASCADE,
    FOREIGN KEY (menu_item_id) REFERENCES MENU_ITEMS(menu_item_id),
    FOREIGN KEY (updated_by_employee_id) REFERENCES EMPLOYEES(employee_id) ON DELETE SET NULL
);

CREATE TABLE ORDER_ITEM_OWNERS (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_item_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    FOREIGN KEY (order_item_id) REFERENCES ORDER_ITEMS(order_item_id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES SESSION_USERS(user_id) ON DELETE CASCADE
);

CREATE TABLE PAYMENTS (
    payment_id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL,
    user_id INTEGER,
    processed_by_employee_id INTEGER,
    amount NUMERIC NOT NULL,
    method TEXT NOT NULL,
    status TEXT NOT NULL,
    slip_ref TEXT,
    paid_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (session_id) REFERENCES SESSIONS(session_id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES SESSION_USERS(user_id) ON DELETE SET NULL,
    FOREIGN KEY (processed_by_employee_id) REFERENCES EMPLOYEES(employee_id) ON DELETE SET NULL
);
`;

// Initial data seeds
const SEEDS = {
    categories: [
        { name: 'ส้มตำ / ยำ' },
        { name: 'ลาบ / น้ำตก / ก้อย' },
        { name: 'ของย่าง / ของทอด' },
        { name: 'ต้ม / แกง / อ่อม' },
        { name: 'ข้าว / เครื่องเคียง' },
        { name: 'เครื่องดื่ม' }
    ],
    tables: Array.from({ length: 20 }, (_, i) => ({
        table_number: String(i + 1),
        status: 'AVAILABLE'
    })),
    menuItems: [
        // ส้มตำ / ยำ (category_id: 1)
        { category_id: 1, name: 'ส้มตำไทย', price: 60, image_url: '', is_available: 1 },
        { category_id: 1, name: 'ส้มตำปู', price: 80, image_url: '', is_available: 1 },
        { category_id: 1, name: 'ส้มตำปลาร้า', price: 70, image_url: '', is_available: 1 },
        { category_id: 1, name: 'ตำหมูยออุบล', price: 80, image_url: '', is_available: 1 },
        { category_id: 1, name: 'ตำข้าวโพด', price: 70, image_url: '', is_available: 1 },
        { category_id: 1, name: 'ตำมะม่วง', price: 70, image_url: '', is_available: 1 },
        { category_id: 1, name: 'ยำวุ้นเส้น', price: 80, image_url: '', is_available: 1 },
        { category_id: 1, name: 'ยำทะเล', price: 100, image_url: '', is_available: 1 },
        { category_id: 1, name: 'ยำไก่', price: 80, image_url: '', is_available: 1 },
        { category_id: 1, name: 'ยำมาม่า', price: 60, image_url: '', is_available: 1 },
        
        // ลาบ / น้ำตก / ก้อย (category_id: 2)
        { category_id: 2, name: 'ลาบหมู', price: 80, image_url: '', is_available: 1 },
        { category_id: 2, name: 'ลาบไก่', price: 80, image_url: '', is_available: 1 },
        { category_id: 2, name: 'ลาบทะเล', price: 100, image_url: '', is_available: 1 },
        { category_id: 2, name: 'น้ำตกหมู', price: 80, image_url: '', is_available: 1 },
        { category_id: 2, name: 'น้ำตกเนื้อ', price: 100, image_url: '', is_available: 1 },
        { category_id: 2, name: 'ก้อยหมู', price: 80, image_url: '', is_available: 1 },
        { category_id: 2, name: 'ก้อยไก่', price: 80, image_url: '', is_available: 1 },
        
        // ของย่าง / ของทอด (category_id: 3)
        { category_id: 3, name: 'ปีกไก่ทอดน้ำปลา', price: 70, image_url: '', is_available: 1 },
        { category_id: 3, name: 'อกไก่ย่าง', price: 80, image_url: '', is_available: 1 },
        { category_id: 3, name: 'หมูย่าง', price: 90, image_url: '', is_available: 1 },
        { category_id: 3, name: 'ปลาทอดกระเทียม', price: 100, image_url: '', is_available: 1 },
        { category_id: 3, name: 'กุ้งทอดกระเทียม', price: 120, image_url: '', is_available: 1 },
        { category_id: 3, name: 'ไก่ทอด', price: 80, image_url: '', is_available: 1 },
        { category_id: 3, name: 'หมูทอด', price: 80, image_url: '', is_available: 1 },
        
        // ต้ม / แกง / อ่อม (category_id: 4)
        { category_id: 4, name: 'ต้มแซ่บกระดูกอ่อน', price: 100, image_url: '', is_available: 1 },
        { category_id: 4, name: 'ต้มยำกุ้ง', price: 120, image_url: '', is_available: 1 },
        { category_id: 4, name: 'ต้มข่าไก่', price: 90, image_url: '', is_available: 1 },
        { category_id: 4, name: 'แกงเขียวหวานไก่', price: 90, image_url: '', is_available: 1 },
        { category_id: 4, name: 'แกงเผ็ดเนื้อ', price: 100, image_url: '', is_available: 1 },
        { category_id: 4, name: 'อ่อมหมู', price: 90, image_url: '', is_available: 1 },
        
        // ข้าว / เครื่องเคียง (category_id: 5)
        { category_id: 5, name: 'ข้าวเหนียว', price: 10, image_url: '', is_available: 1 },
        { category_id: 5, name: 'ข้าวสวย', price: 10, image_url: '', is_available: 1 },
        { category_id: 5, name: 'ไส้กรอกอีสาน', price: 40, image_url: '', is_available: 1 },
        { category_id: 5, name: 'หมูสับ', price: 40, image_url: '', is_available: 1 },
        { category_id: 5, name: 'ผักกาดดอง', price: 20, image_url: '', is_available: 1 },
        
        // เครื่องดื่ม (category_id: 6)
        { category_id: 6, name: 'น้ำเปล่า', price: 10, image_url: '', is_available: 1 },
        { category_id: 6, name: 'ชาเย็น', price: 25, image_url: '', is_available: 1 },
        { category_id: 6, name: 'กาแฟเย็น', price: 30, image_url: '', is_available: 1 },
        { category_id: 6, name: 'น้ำมะนาว', price: 20, image_url: '', is_available: 1 },
        { category_id: 6, name: 'น้ำอ้อย', price: 20, image_url: '', is_available: 1 },
        { category_id: 6, name: 'โค้ก', price: 20, image_url: '', is_available: 1 },
        { category_id: 6, name: 'สไปร์ท', price: 20, image_url: '', is_available: 1 },
        { category_id: 6, name: 'น้ำอัดลม', price: 20, image_url: '', is_available: 1 }
    ]
};

/**
 * Initialize database with schema and seed data
 * Returns Promise that resolves when initialization is complete
 */
function initializeDatabase(db) {
    return new Promise((resolve, reject) => {
        // Check if database already has tables
        db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='TABLES'", [], (err, row) => {
            if (err) return reject(err);
            
            if (row) {
                // Tables already exist, just run migration
                console.log('[DB Init] Database already initialized, skipping schema creation');
                resolve();
                return;
            }
            
            console.log('[DB Init] Initializing empty database...');
            
            // Execute schema
            db.exec(SCHEMA_SQL, (err) => {
                if (err) return reject(err);
                console.log('[DB Init] Schema created');
                
                // Seed categories
                const catStmt = db.prepare('INSERT INTO CATEGORIES (name) VALUES (?)');
                SEEDS.categories.forEach(c => catStmt.run(c.name));
                catStmt.finalize();
                
                // Seed tables
                const tableStmt = db.prepare('INSERT INTO TABLES (table_number, status) VALUES (?, ?)');
                SEEDS.tables.forEach(t => tableStmt.run(t.table_number, t.status));
                tableStmt.finalize();
                
                // Seed menu items
                const menuStmt = db.prepare('INSERT INTO MENU_ITEMS (category_id, name, price, image_url, is_available) VALUES (?, ?, ?, ?, ?)');
                SEEDS.menuItems.forEach(m => menuStmt.run(m.category_id, m.name, m.price, m.image_url, m.is_available));
                menuStmt.finalize();
                
                // Seed default employee (kitchen)
                db.run("INSERT INTO EMPLOYEES (name, role) VALUES (?, 'kitchen')", ['พนักงานครัว'], function(err) {
                    if (err) return reject(err);
                    console.log('[DB Init] Seed data inserted');
                    resolve();
                });
            });
        });
    });
}

module.exports = { initializeDatabase };