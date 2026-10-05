const express = require('express');
const { STATUS, canTransition } = require('../lib/order-status');

/**
 * Kitchen routes
 * Export function that receives db and returns router
 */
module.exports = function kitchenRoutes(db) {
    const router = express.Router();
    
    // Body parser for this router (ensures req.body works when mounted)
    router.use(express.json());
    router.use(express.urlencoded({ extended: true }));

    // ============================================================
    // Helper: Query orders grouped by table
    // ============================================================
    function getKitchenOrders(scope, callback) {
        // scope: 'new' -> status='ordered', 'accepted' -> status='cooking'
        const targetStatus = scope === 'new' ? STATUS.ORDERED : STATUS.COOKING;
        if (!targetStatus) return callback(new Error('Invalid scope'));

        const sql = `
            SELECT 
                t.table_id,
                t.table_number,
                oi.order_item_id,
                mi.name,
                oi.qty,
                oi.note,
                oi.status,
                oi.sent_at,
                oi.updated_by_employee_id,
                o.created_at as order_created_at,
                s.session_id
            FROM ORDER_ITEMS oi
            JOIN ORDERS o ON oi.order_id = o.order_id
            JOIN SESSIONS s ON o.session_id = s.session_id
            JOIN TABLES t ON s.table_id = t.table_id
            JOIN MENU_ITEMS mi ON oi.menu_item_id = mi.menu_item_id
            WHERE oi.status = ?
              AND LOWER(TRIM(o.status)) = 'active'
              AND LOWER(TRIM(s.status)) = 'active'
            ORDER BY COALESCE(oi.sent_at, o.created_at) ASC
        `;

        db.all(sql, [targetStatus], (err, rows) => {
            if (err) return callback(err);

            // Group by table
            const tableMap = new Map();
            for (const row of rows) {
                const key = row.table_id;
                if (!tableMap.has(key)) {
                    tableMap.set(key, {
                        table_id: row.table_id,
                        table_number: row.table_number,
                        oldest_sent_at: row.sent_at || row.order_created_at,
                        items: []
                    });
                }
                const table = tableMap.get(key);
                // Update oldest_sent_at if this item is older
                const itemTime = row.sent_at || row.order_created_at;
                if (itemTime < table.oldest_sent_at) {
                    table.oldest_sent_at = itemTime;
                }
                table.items.push({
                    order_item_id: row.order_item_id,
                    name: row.name,
                    qty: row.qty,
                    note: row.note,
                    status: row.status,
                    sent_at: row.sent_at,
                    updated_by_employee_id: row.updated_by_employee_id
                });
            }

            // Convert to array and sort by oldest_sent_at (oldest first)
            const tables = Array.from(tableMap.values()).sort((a, b) => {
                return new Date(a.oldest_sent_at) - new Date(b.oldest_sent_at);
            });

            callback(null, { success: true, tables });
        });
    }

    // ============================================================
    // GET /api/kitchen/orders?scope=new|accepted
    // ============================================================
    router.get('/api/kitchen/orders', (req, res) => {
        const scope = req.query.scope;
        if (scope !== 'new' && scope !== 'accepted') {
            return res.status(400).json({ success: false, message: 'scope ต้องเป็น new หรือ accepted' });
        }

        getKitchenOrders(scope, (err, result) => {
            if (err) {
                console.error('[Kitchen API] GET orders error:', err.message);
                return res.status(500).json({ success: false, message: 'โหลดข้อมูลไม่สำเร็จ' });
            }
            res.json(result);
        });
    });

    // ============================================================
    // POST /api/kitchen/accept
    // Atomic UPDATE: ordered -> cooking, set updated_by_employee_id
    // ============================================================
    router.post('/api/kitchen/accept', (req, res) => {
        const { order_item_ids } = req.body;

        // Validate input
        if (!Array.isArray(order_item_ids) || order_item_ids.length === 0) {
            return res.status(400).json({ success: false, message: 'order_item_ids ต้องเป็น array ไม่ว่าง' });
        }
        if (order_item_ids.length > 100) {
            return res.status(400).json({ success: false, message: 'รับรายการได้สูงสุด 100 รายการต่อครั้ง' });
        }
        // Validate all are positive integers
        for (const id of order_item_ids) {
            if (!Number.isInteger(id) || id <= 0) {
                return res.status(400).json({ success: false, message: 'order_item_ids ต้องเป็นจำนวนเต็มบวก' });
            }
        }

        // Get kitchen employee id
        db.get("SELECT employee_id FROM EMPLOYEES WHERE role = 'kitchen' LIMIT 1", [], (err, emp) => {
            if (err || !emp) {
                console.error('[Kitchen API] No kitchen employee found');
                return res.status(500).json({ success: false, message: 'ไม่พบพนักงานครัวในระบบ' });
            }
            const kitchenEmployeeId = emp.employee_id;

            // Build placeholders for IN clause
            const placeholders = order_item_ids.map(() => '?').join(',');
            const sql = `
                UPDATE ORDER_ITEMS
                SET status = 'cooking', updated_by_employee_id = ?
                WHERE order_item_id IN (${placeholders}) AND status = 'ordered'
            `;

            const params = [kitchenEmployeeId, ...order_item_ids];

            db.run(sql, params, function (err) {
                if (err) {
                    console.error('[Kitchen API] Accept error:', err.message);
                    return res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาดในการรับงาน' });
                }

                if (this.changes === 0) {
                    // No rows updated = all items already taken by someone else
                    return res.status(409).json({ 
                        success: false, 
                        message: 'มีคนรับรายการนี้ไปแล้ว',
                        accepted: 0
                    });
                }

                res.json({ success: true, accepted: this.changes });
            });
        });
    });

    // ============================================================
    // POST /api/kitchen/item/:id/status
    // Change status: cooking <-> ready (kitchen role)
    // ============================================================
    router.post('/api/kitchen/item/:id/status', (req, res) => {
        const itemId = parseInt(req.params.id);
        const { status } = req.body;

        if (!Number.isInteger(itemId) || itemId <= 0) {
            return res.status(400).json({ success: false, message: 'ID ไม่ถูกต้อง' });
        }
        if (status !== STATUS.COOKING && status !== STATUS.READY) {
            return res.status(400).json({ success: false, message: 'สถานะต้องเป็น cooking หรือ ready' });
        }

        // First, get current status
        db.get('SELECT status FROM ORDER_ITEMS WHERE order_item_id = ?', [itemId], (err, row) => {
            if (err) {
                console.error('[Kitchen API] Get status error:', err.message);
                return res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' });
            }
            if (!row) {
                return res.status(404).json({ success: false, message: 'ไม่พบรายการอาหาร' });
            }

            const currentStatus = row.status;

            // Validate transition using order-status lib
            if (!canTransition('kitchen', currentStatus, status)) {
                return res.status(409).json({ 
                    success: false, 
                    message: `ไม่สามารถเปลี่ยนจาก ${currentStatus} เป็น ${status} ได้`,
                    currentStatus 
                });
            }

            // Atomic update with condition
            const sql = `
                UPDATE ORDER_ITEMS
                SET status = ?
                WHERE order_item_id = ? AND status = ?
            `;

            db.run(sql, [status, itemId, currentStatus], function (err) {
                if (err) {
                    console.error('[Kitchen API] Status update error:', err.message);
                    return res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาดในการอัปเดตสถานะ' });
                }

                if (this.changes === 0) {
                    // Status changed by another request (race condition)
                    return res.status(409).json({ 
                        success: false, 
                        message: 'สถานะเปลี่ยนไปแล้ว กรุณารีเฟรชหน้าจอ',
                        currentStatus 
                    });
                }

                res.json({ success: true, order_item_id: itemId, status });
            });
        });
    });

    // ============================================================
    // Helper function for rendering views (reuse query logic)
    // ============================================================
    function renderKitchenView(req, res, scope, viewName) {
        getKitchenOrders(scope, (err, result) => {
            if (err) {
                console.error('[Kitchen View] Error:', err.message);
                return res.status(500).send('โหลดข้อมูลไม่สำเร็จ');
            }
            res.render(viewName, { 
                tables: result.tables || [],
                scope,
                STATUS
            });
        });
    }

    // ============================================================
    // GET /kitchen - หน้าออเดอร์ใหม่ (scope=new)
    // ============================================================
    router.get('/kitchen', (req, res) => {
        renderKitchenView(req, res, 'new', 'kitchen');
    });

    // ============================================================
    // GET /kitchen/accepted - หน้างานที่รับแล้ว (scope=accepted)
    // ============================================================
    router.get('/kitchen/accepted', (req, res) => {
        renderKitchenView(req, res, 'accepted', 'kitchen-accepted');
    });

    // ============================================================
    // GET /kitchen/table/:table_id - หน้าอัปเดตสถานะรายโต๊ะ
    // ============================================================
    router.get('/kitchen/table/:table_id', (req, res) => {
        const tableId = req.params.table_id;

        // Get table info
        db.get('SELECT table_id, table_number FROM TABLES WHERE table_id = ?', [tableId], (err, table) => {
            if (err || !table) {
                return res.status(404).send('ไม่พบโต๊ะ');
            }

            // Get cooking items for this table
            const cookingSql = `
                SELECT 
                    oi.order_item_id,
                    mi.name,
                    oi.qty,
                    oi.note,
                    oi.status,
                    oi.sent_at,
                    oi.updated_by_employee_id
                FROM ORDER_ITEMS oi
                JOIN ORDERS o ON oi.order_id = o.order_id
                JOIN SESSIONS s ON o.session_id = s.session_id
                JOIN MENU_ITEMS mi ON oi.menu_item_id = mi.menu_item_id
                WHERE s.table_id = ?
                  AND oi.status = 'cooking'
                  AND LOWER(TRIM(o.status)) = 'active'
                  AND LOWER(TRIM(s.status)) = 'active'
                ORDER BY oi.order_item_id ASC
            `;

            // Get ready items for this table
            const readySql = `
                SELECT 
                    oi.order_item_id,
                    mi.name,
                    oi.qty,
                    oi.note,
                    oi.status,
                    oi.sent_at,
                    oi.updated_by_employee_id
                FROM ORDER_ITEMS oi
                JOIN ORDERS o ON oi.order_id = o.order_id
                JOIN SESSIONS s ON o.session_id = s.session_id
                JOIN MENU_ITEMS mi ON oi.menu_item_id = mi.menu_item_id
                WHERE s.table_id = ?
                  AND oi.status = 'ready'
                  AND LOWER(TRIM(o.status)) = 'active'
                  AND LOWER(TRIM(s.status)) = 'active'
                ORDER BY oi.order_item_id ASC
            `;

            db.all(cookingSql, [tableId], (err, cookingItems) => {
                if (err) {
                    console.error('[Kitchen Table] Cooking query error:', err.message);
                    return res.status(500).send('โหลดข้อมูลไม่สำเร็จ');
                }
                db.all(readySql, [tableId], (err, readyItems) => {
                    if (err) {
                        console.error('[Kitchen Table] Ready query error:', err.message);
                        return res.status(500).send('โหลดข้อมูลไม่สำเร็จ');
                    }
                    res.render('kitchen-table', {
                        table,
                        cookingItems: cookingItems || [],
                        readyItems: readyItems || [],
                        STATUS
                    });
                });
            });
        });
    });

    return router;
};