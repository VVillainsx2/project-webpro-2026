const sqlite3 = require('sqlite3').verbose();
const path = require('path');

/**
 * Migration สำหรับฝั่งครัว
 * - เพิ่มคอลัมน์ sent_at ใน ORDER_ITEMS (ถ้ายังไม่มี)
 * - Seed พนักงานครัว role='kitchen' (ถ้ายังไม่มี)
 * รันซ้ำได้ปลอดภัย (idempotent)
 */
function runKitchenMigration(db) {
    return new Promise((resolve, reject) => {
        // 1. ตรวจสอบว่ามีคอลัมน์ sent_at ใน ORDER_ITEMS หรือยัง
        db.all("PRAGMA table_info(ORDER_ITEMS)", [], (err, columns) => {
            if (err) return reject(err);

            const hasSentAt = columns.some(c => c.name === 'sent_at');

            if (!hasSentAt) {
                // เพิ่มคอลัมน์ sent_at
                db.run("ALTER TABLE ORDER_ITEMS ADD COLUMN sent_at DATETIME", (err) => {
                    if (err) return reject(err);
                    console.log('[migrate-kitchen] Added sent_at column to ORDER_ITEMS');
                    seedKitchenEmployee(db, resolve, reject);
                });
            } else {
                console.log('[migrate-kitchen] sent_at column already exists, skipping ALTER');
                seedKitchenEmployee(db, resolve, reject);
            }
        });
    });
}

function seedKitchenEmployee(db, resolve, reject) {
    // 2. ตรวจสอบว่ามีพนักงาน role='kitchen' อยู่แล้วหรือยัง
    db.get("SELECT employee_id FROM EMPLOYEES WHERE role = 'kitchen' LIMIT 1", [], (err, row) => {
        if (err) return reject(err);

        if (!row) {
            // ยังไม่มี -> insert
            db.run("INSERT INTO EMPLOYEES (name, role) VALUES (?, 'kitchen')", ['พนักงานครัว'], function (err) {
                if (err) return reject(err);
                console.log('[migrate-kitchen] Seeded kitchen employee with id:', this.lastID);
                resolve(this.lastID);
            });
        } else {
            console.log('[migrate-kitchen] Kitchen employee already exists, id:', row.employee_id);
            resolve(row.employee_id);
        }
    });
}

/**
 * เรียกใช้ migration แบบ standalone (สำหรับทดสอบ)
 */
if (require.main === module) {
    const db = new sqlite3.Database(path.join(__dirname, '..', 'database.db'));
    runKitchenMigration(db)
        .then(kitchenEmployeeId => {
            console.log('[migrate-kitchen] Migration completed. kitchenEmployeeId =', kitchenEmployeeId);
            db.close();
        })
        .catch(err => {
            console.error('[migrate-kitchen] Migration failed:', err);
            db.close();
            process.exit(1);
        });
}

module.exports = { runKitchenMigration };