const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// View engine setup
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Middlewares
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Database connection
const db = new sqlite3.Database('./database.db', (err) => {
    if (err) {
        console.error('DB Error:', err.message);
    } else {
        console.log('Connected to SQLite database.');
        // เปิดใช้งาน Foreign Keys Constraint ใน SQLite
        db.run('PRAGMA foreign_keys = ON;');
        // Kitchen migration (รันตอนสตาร์ต อัตโนมัติ รันซ้ำได้ปลอดภัย)
        require('./lib/migrate-kitchen').runKitchenMigration(db).catch(err => {
            console.error('[Kitchen Migration] Failed:', err.message);
        });
    }
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
    console.error('[Unhandled Rejection]:', reason);
});

process.on('uncaughtException', (err) => {
    console.error('[Uncaught Exception]:', err);
});

// Settings
const PROMPTPAY_NO = '0812345678'; // หมายเลข PromptPay ร้านค้า

// -----------------------------------------------------------------------------
// 1. หน้าต้อนรับ
// -----------------------------------------------------------------------------
app.get('/', (req, res) => {
    const sessionId = req.query.session_id || 1;

    db.all('SELECT * FROM SESSION_USERS WHERE session_id = ?', [sessionId], (err, existingUsers) => {
        if (err) existingUsers = [];

        res.render('index', {
            sessionId: sessionId,
            shopName: "ไอทีม่วนแจ่ม",
            existingUsers: existingUsers,
            instructions: [
                "ใส่ชื่อเล่นของคุณและเริ่มสั่งอาหาร",
                "เพิ่มรายการได้ทุกเมื่อ",
                "แยกจ่ายเงินและจ่ายตามที่คุณต้องการ"
            ]
        });
    });
});

app.post('/join-session', (req, res) => {
    const { session_id, table_id, name } = req.body;
    if (!name || name.trim() === '') {
        return res.send('<script>alert("กรุณากรอกชื่อเล่น"); window.history.back();</script>');
    }

    const targetTableId = table_id || session_id || 1;
    const ensureTableSql = `INSERT OR IGNORE INTO TABLES (table_id, table_number, status) VALUES (?, ?, 'AVAILABLE')`;

    db.run(ensureTableSql, [targetTableId, String(targetTableId)], (err) => {
        if (err) console.log('Ensure table notice:', err.message);

        db.get('SELECT session_id FROM SESSIONS WHERE table_id = ? AND LOWER(status) = "active"', [targetTableId], (err, activeSession) => {
            if (err) {
                console.error('Error checking active session:', err.message);
                return res.status(500).send('เกิดข้อผิดพลาดในการตรวจสอบ Session');
            }

            const saveUserAndRedirect = (sessionIdToUse) => {
                const sqlUser = `INSERT INTO SESSION_USERS (session_id, name, is_paid) VALUES (?, ?, 0)`;
                db.run(sqlUser, [sessionIdToUse, name.trim()], function (err) {
                    if (err) {
                        console.error('Error saving user:', err.message);
                        return res.status(500).send('เกิดข้อผิดพลาดในการบันทึกข้อมูลผู้ใช้');
                    }
                    res.redirect(`/menu?session_id=${sessionIdToUse}&user_id=${this.lastID}`);
                });
            };

            if (activeSession) {
                saveUserAndRedirect(activeSession.session_id);
            } else {
                const createSessionSql = `INSERT INTO SESSIONS (table_id, status) VALUES (?, 'active')`;
                db.run(createSessionSql, [targetTableId], function (err) {
                    if (err) {
                        console.error('Error creating new session:', err.message);
                        return res.status(500).send('เกิดข้อผิดพลาดในการสร้าง Session ใหม่: ' + err.message);
                    }
                    saveUserAndRedirect(this.lastID);
                });
            }
        });
    });
});

// -----------------------------------------------------------------------------
// 2. หน้าแสดงรายการอาหาร (Menu Page)
// -----------------------------------------------------------------------------
app.get('/menu', (req, res) => {
    const { session_id, user_id } = req.query;

    if (!session_id || !user_id) {
        return res.redirect('/');
    }

    db.get('SELECT * FROM SESSION_USERS WHERE user_id = ?', [user_id], (err, user) => {
        if (err || !user) return res.status(400).send('ไม่พบข้อมูลผู้ใช้งาน');

        db.all('SELECT * FROM SESSION_USERS WHERE session_id = ?', [session_id], (err, sessionUsers) => {
            if (err) sessionUsers = [];

            db.all('SELECT * FROM CATEGORIES', [], (err, categories) => {
                if (err) categories = [];

                db.all('SELECT * FROM MENU_ITEMS WHERE is_available = 1', [], (err, menuItems) => {
                    if (err) menuItems = [];

                    res.render('menu', {
                        user: user,
                        sessionUsers: sessionUsers,
                        categories: categories,
                        menuItems: menuItems,
                        sessionId: session_id,
                        userId: user_id
                    });
                });
            });
        });
    });
});

// -----------------------------------------------------------------------------
// 3. รับฟอร์มเพิ่มรายการอาหารลงตะกร้า (status = 'pending')
// -----------------------------------------------------------------------------
app.post('/order/add', (req, res) => {
    const { session_id, user_id, menu_item_id, qty, note, shared_user_ids } = req.body;
    const itemQty = parseInt(qty) || 1;

    let ownersList = [];
    if (Array.isArray(shared_user_ids)) {
        ownersList = shared_user_ids;
    } else if (shared_user_ids) {
        ownersList = [shared_user_ids];
    } else {
        ownersList = [user_id];
    }

    db.get('SELECT order_id FROM ORDERS WHERE session_id = ? AND LOWER(status) = "active"', [session_id], (err, order) => {
        if (err) return res.status(500).send('เกิดข้อผิดพลาดในการตรวจสอบออเดอร์');

        const insertOrderItem = (orderId) => {
            const sqlItem = `INSERT INTO ORDER_ITEMS (order_id, menu_item_id, qty, note, status) VALUES (?, ?, ?, ?, 'pending')`;

            db.run(sqlItem, [orderId, menu_item_id, itemQty, note || ''], function (err) {
                if (err) return res.status(500).send('ไม่สามารถเพิ่มรายการอาหารได้');

                const orderItemId = this.lastID;
                if (ownersList.length === 0) {
                    return res.redirect(`/menu?session_id=${session_id}&user_id=${user_id}`);
                }

                const placeholders = ownersList.map(() => '(?, ?)').join(', ');
                const sqlOwners = `INSERT INTO ORDER_ITEM_OWNERS (order_item_id, user_id) VALUES ${placeholders}`;

                const ownerParams = [];
                ownersList.forEach(uId => {
                    ownerParams.push(orderItemId, uId);
                });

                db.run(sqlOwners, ownerParams, (err) => {
                    if (err) console.error('Error inserting item owners:', err.message);
                    res.redirect(`/menu?session_id=${session_id}&user_id=${user_id}`);
                });
            });
        };

        if (!order) {
            db.run('INSERT INTO ORDERS (session_id, status) VALUES (?, "active")', [session_id], function (err) {
                if (err) return res.status(500).send('เกิดข้อผิดพลาดในการสร้างออเดอร์');
                insertOrderItem(this.lastID);
            });
        } else {
            insertOrderItem(order.order_id);
        }
    });
});

// API เพิ่มผู้ใช้งานใหม่ชั่วคราว
app.post('/api/add-user', (req, res) => {
    const { session_id, name } = req.body;
    if (!name || name.trim() === '') {
        return res.status(400).json({ error: 'กรุณากรอกชื่อเล่น' });
    }

    const sql = `INSERT INTO SESSION_USERS (session_id, name, is_paid) VALUES (?, ?, 0)`;
    db.run(sql, [session_id || 1, name.trim()], function (err) {
        if (err) return res.status(500).json({ error: 'เกิดข้อผิดพลาดในการบันทึกข้อมูล' });

        res.json({
            user_id: this.lastID,
            name: name.trim()
        });
    });
});

// -----------------------------------------------------------------------------
// 4. หน้าแสดงตะกร้าสินค้า
// -----------------------------------------------------------------------------
app.get('/cart', (req, res) => {
    const { session_id, user_id } = req.query;

    if (!session_id || !user_id) {
        return res.redirect('/');
    }

    db.get('SELECT * FROM SESSION_USERS WHERE user_id = ?', [user_id], (err, currentUser) => {
        if (err || !currentUser) return res.redirect('/');

        db.all('SELECT * FROM SESSION_USERS WHERE session_id = ?', [session_id], (err, sessionUsers) => {
            if (err) sessionUsers = [];

            db.get('SELECT order_id FROM ORDERS WHERE session_id = ? AND LOWER(status) = "active"', [session_id], (err, order) => {
                if (err || !order) {
                    return res.render('cart', {
                        currentUser,
                        sessionUsers,
                        cartItems: [],
                        myTotalAmount: 0,
                        tableTotalAmount: 0,
                        myItemsCount: 0,
                        tableNo: session_id,
                        sessionId: session_id,
                        userId: user_id
                    });
                }

                const query = `
                    SELECT 
                        oi.order_item_id AS id,
                        oi.qty AS quantity,
                        oi.note,
                        oi.status,
                        mi.name AS title,
                        mi.price,
                        mi.image_url AS image,
                        GROUP_CONCAT(su.user_id) AS owner_ids,
                        GROUP_CONCAT(su.name) AS owner_names
                    FROM ORDER_ITEMS oi
                    JOIN MENU_ITEMS mi ON oi.menu_item_id = mi.menu_item_id
                    LEFT JOIN ORDER_ITEM_OWNERS oio ON oi.order_item_id = oio.order_item_id
                    LEFT JOIN SESSION_USERS su ON oio.user_id = su.user_id
                    WHERE oi.order_id = ? AND oi.status = 'pending'
                    GROUP BY oi.order_item_id
                    ORDER BY oi.order_item_id DESC
                `;

                db.all(query, [order.order_id], (err, rawItems) => {
                    if (err) rawItems = [];

                    let myTotalAmount = 0;
                    let tableTotalAmount = 0;
                    let myItemsCount = 0;

                    const cartItems = rawItems.map(item => {
                        const itemTotal = item.price * item.quantity;
                        tableTotalAmount += itemTotal;

                        const ownerIds = item.owner_ids ? item.owner_ids.split(',') : [];
                        const ownerNamesList = item.owner_names ? item.owner_names.split(',') : [];
                        const shareCount = ownerIds.length || 1;
                        const pricePerPerson = itemTotal / shareCount;

                        const isMyItem = ownerIds.includes(String(user_id));

                        if (isMyItem) {
                            myTotalAmount += pricePerPerson;
                            myItemsCount += 1;
                        }

                        return {
                            ...item,
                            itemTotal,
                            ownerIds,
                            ownerNames: ownerNamesList.join(', '),
                            shareCount,
                            pricePerPerson,
                            isMyItem
                        };
                    });

                    res.render('cart', {
                        currentUser,
                        sessionUsers,
                        cartItems,
                        myTotalAmount,
                        tableTotalAmount,
                        myItemsCount,
                        tableNo: session_id,
                        sessionId: session_id,
                        userId: user_id
                    });
                });
            });
        });
    });
});

// -----------------------------------------------------------------------------
// 5. API ยืนยันออร์เดอร์ส่งเข้าครัว (pending -> ordered)
// -----------------------------------------------------------------------------
app.post('/api/orders/send-to-kitchen', (req, res) => {
    const { tableNo, userId } = req.body;
    const sessionId = tableNo;

    db.get('SELECT order_id FROM ORDERS WHERE session_id = ? AND LOWER(status) = "active"', [sessionId], (err, order) => {
        if (err || !order) {
            return res.status(400).json({ success: false, message: 'ไม่พบออเดอร์ที่เปิดใช้งานอยู่' });
        }

        const sqlUpdate = `
            UPDATE ORDER_ITEMS 
            SET status = 'ordered', sent_at = CURRENT_TIMESTAMP
            WHERE order_id = ? 
              AND status = 'pending' 
              AND order_item_id IN (
                  SELECT order_item_id FROM ORDER_ITEM_OWNERS WHERE user_id = ?
              )
        `;

        db.run(sqlUpdate, [order.order_id, userId], function (err) {
            if (err) {
                console.error('Error updating status to ordered:', err.message);
                return res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาดในการส่งเข้าครัว' });
            }

            if (this.changes === 0) {
                return res.status(400).json({ success: false, message: 'ไม่มีรายการอาหารใหม่ให้ส่งเข้าครัว' });
            }

            res.json({ success: true, message: 'ส่งออเดอร์เข้าครัวเรียบร้อยแล้ว', tableNo: sessionId });
        });
    });
});

// -----------------------------------------------------------------------------
// 6. ลบรายการอาหารในตะกร้า
// -----------------------------------------------------------------------------
app.delete('/api/cart/item/:id', (req, res) => {
    const itemId = req.params.id;

    db.run('DELETE FROM ORDER_ITEM_OWNERS WHERE order_item_id = ?', [itemId], (err) => {
        if (err) return res.status(500).json({ success: false, message: 'ไม่สามารถลบรายการได้' });

        db.run('DELETE FROM ORDER_ITEMS WHERE order_item_id = ?', [itemId], (err) => {
            if (err) return res.status(500).json({ success: false, message: 'ไม่สามารถลบรายการได้' });
            res.json({ success: true });
        });
    });
});

app.post('/order/item/delete', (req, res) => {
    const { order_item_id, session_id, user_id } = req.body;

    db.run('DELETE FROM ORDER_ITEM_OWNERS WHERE order_item_id = ?', [order_item_id], (err) => {
        if (err) return res.status(500).send('ไม่สามารถลบรายการได้');

        db.run('DELETE FROM ORDER_ITEMS WHERE order_item_id = ?', [order_item_id], (err) => {
            if (err) return res.status(500).send('ไม่สามารถลบรายการได้');
            res.redirect(`/cart?session_id=${session_id}&user_id=${user_id}`);
        });
    });
});

// Reset Database API
app.delete('/resetdatabase', (req, res) => {
    const sql = `
        PRAGMA foreign_keys = OFF;
        DELETE FROM ORDER_ITEM_OWNERS;
        DELETE FROM ORDER_ITEMS;
        DELETE FROM ORDERS;
        DELETE FROM PAYMENTS;
        DELETE FROM SESSION_USERS;
        DELETE FROM SESSIONS;
        UPDATE TABLES SET status = 'AVAILABLE';
        DELETE FROM sqlite_sequence WHERE name IN (
            'SESSIONS', 
            'SESSION_USERS', 
            'ORDERS', 
            'ORDER_ITEMS', 
            'ORDER_ITEM_OWNERS', 
            'PAYMENTS'
        );
        PRAGMA foreign_keys = ON;
    `;

    db.exec(sql, function (err) {
        if (err) {
            console.log('Error deleting database:', err.message);
            return res.status(500).json({ error: err.message });
        }

        db.get('SELECT table_id FROM TABLES LIMIT 1', [], (err, tableRow) => {
            const createSession = (validTableId) => {
                const createSessionSql = `INSERT INTO SESSIONS (table_id, status) VALUES (?, 'active')`;

                db.run(createSessionSql, [validTableId], function (err) {
                    if (err) {
                        console.log('Error creating new session:', err.message);
                        return res.status(500).json({ error: 'ล้างฐานข้อมูลสำเร็จ แต่สร้าง Session ใหม่ไม่สำเร็จ: ' + err.message });
                    }

                    res.json({ 
                        message: 'Database reset and new session created successfully',
                        new_session_id: this.lastID,
                        table_id: validTableId
                    });
                });
            };

            if (tableRow) {
                createSession(tableRow.table_id);
            } else {
                const defaultTableId = req.body?.table_id || req.query?.table_id || 1;

                db.run(`INSERT INTO TABLES (table_id, status) VALUES (?, 'AVAILABLE')`, [defaultTableId], function (err) {
                    if (err) {
                        db.run(`INSERT INTO TABLES (status) VALUES ('AVAILABLE')`, [], function (err2) {
                            createSession(this.lastID || defaultTableId);
                        });
                    } else {
                        createSession(defaultTableId);
                    }
                });
            }
        });
    });
});

// -----------------------------------------------------------------------------
// 7. ส่วนงานแคชเชียร์ (Cashier)
// -----------------------------------------------------------------------------

// หน้าหลักแคชเชียร์ (แสดงผังโต๊ะ)
app.get('/cashier', (req, res) => {
    const sql = `
        SELECT 
            t.table_id,
            t.table_number,
            CASE 
                WHEN COUNT(s.session_id) > 0 THEN 'OCCUPIED'
                ELSE 'AVAILABLE'
            END AS status,
            CASE 
                WHEN COUNT(s.session_id) > 0 THEN 'OCCUPIED'
                ELSE 'AVAILABLE'
            END AS calculated_status
        FROM TABLES t
        LEFT JOIN SESSIONS s 
          ON CAST(s.table_id AS TEXT) = CAST(t.table_id AS TEXT) 
         AND LOWER(TRIM(s.status)) = 'active'
        GROUP BY t.table_id, t.table_number
        ORDER BY CAST(t.table_number AS INTEGER) ASC
    `;

    db.all(sql, [], (err, tables) => {
        if (err) {
            console.error('Error fetching tables:', err);
            return res.status(500).send('เกิดข้อผิดพลาดในการดึงข้อมูลโต๊ะ');
        }
        res.render('cashier', { tables: tables || [] });
    });
});

// หน้าแสดงรายละเอียดออเดอร์รายโต๊ะ
app.get('/cashier/table/:table_id', (req, res) => {
    const tableId = req.params.table_id;

    const sessionSql = `
        SELECT session_id 
        FROM SESSIONS 
        WHERE CAST(table_id AS TEXT) = CAST(? AS TEXT) 
          AND LOWER(status) = 'active' 
        ORDER BY session_id DESC 
        LIMIT 1
    `;

    db.get(sessionSql, [tableId], (err, session) => {
        if (err) {
            console.error('Error fetching session:', err);
            return res.status(500).send('เกิดข้อผิดพลาดในระบบ');
        }

        if (!session) {
            return res.render('cas-tab-detail', { 
                tableId: tableId, 
                orders: [], 
                splitDetails: [], 
                totalPrice: 0 
            });
        }

        const sessionId = session.session_id;

        db.all(`SELECT user_id, name FROM SESSION_USERS WHERE session_id = ?`, [sessionId], (err, users) => {
            if (err) users = [];

            const orderSql = `
                SELECT 
                    oi.order_item_id,
                    oi.status as item_status,
                    mi.name,
                    mi.price,
                    mi.image_url,
                    oi.qty as quantity,
                    GROUP_CONCAT(su.name, ', ') as owner_names
                FROM ORDER_ITEMS oi
                JOIN ORDERS o ON oi.order_id = o.order_id
                JOIN MENU_ITEMS mi ON oi.menu_item_id = mi.menu_item_id
                LEFT JOIN ORDER_ITEM_OWNERS oio ON oi.order_item_id = oio.order_item_id
                LEFT JOIN SESSION_USERS su ON oio.user_id = su.user_id
                WHERE o.session_id = ?
                GROUP BY oi.order_item_id
                ORDER BY oi.order_item_id DESC
            `;

            db.all(orderSql, [sessionId], (err, rawOrders) => {
                if (err) rawOrders = [];

                let totalPrice = 0;
                let userTotals = {};

                users.forEach(u => {
                    userTotals[u.name] = { total: 0, calcText: [] };
                });

                const processedOrders = rawOrders.map(order => {
                    const itemTotal = order.price * order.quantity;
                    totalPrice += itemTotal;

                    let tags = order.owner_names ? order.owner_names.split(', ') : [];

                    if (tags.length === 0) {
                        if (users.length > 0) {
                            const splitPrice = itemTotal / users.length;
                            users.forEach(u => {
                                if (userTotals[u.name]) {
                                    userTotals[u.name].total += splitPrice;
                                    userTotals[u.name].calcText.push(splitPrice.toFixed(2));
                                }
                            });
                        }
                    } else {
                        const splitPrice = itemTotal / tags.length;
                        tags.forEach(name => {
                            if (userTotals[name]) {
                                userTotals[name].total += splitPrice;
                                userTotals[name].calcText.push(splitPrice.toFixed(2));
                            }
                        });
                    }

                    return {
                        ...order,
                        tags: tags,
                        itemTotal: itemTotal,
                        splitPricePerPerson: tags.length > 0 
                            ? (itemTotal / tags.length) 
                            : (users.length > 0 ? itemTotal / users.length : itemTotal)
                    };
                });

                const splitDetails = Object.keys(userTotals).map(name => {
                    const detail = userTotals[name];
                    return {
                        name: name,
                        calcString: detail.calcText.length > 0 
                                    ? detail.calcText.join(' + ') + ` = ${detail.total.toFixed(2)}.-` 
                                    : `0.00.-`,
                        total: detail.total
                    };
                });

                res.render('cas-tab-detail', {
                    tableId: tableId,
                    orders: processedOrders,
                    splitDetails: splitDetails,
                    totalPrice: totalPrice
                });
            });
        });
    });
});

// หน้าแสดงการชำระเงินแยกจ่าย (Split Payment)
app.get('/cashier/table/:table_id/payment', (req, res) => {
    const tableId = req.params.table_id;

    const sessionSql = `
        SELECT session_id 
        FROM SESSIONS 
        WHERE CAST(table_id AS TEXT) = CAST(? AS TEXT) 
          AND LOWER(status) = 'active' 
        ORDER BY session_id DESC 
        LIMIT 1
    `;

    db.get(sessionSql, [tableId], (err, session) => {
        if (err || !session) {
            return res.render('payment', {
                tableId: tableId,
                sessionId: null,
                paymentList: [],
                paidCount: 0,
                totalUsers: 0
            });
        }

        const sessionId = session.session_id;

        // ดึงคอลัมน์ is_paid เพิ่มเติมเพื่อแสดงผลสถานะชำระเงินของแต่ละคน
        const userSql = `
            SELECT user_id, name, is_paid 
            FROM SESSION_USERS 
            WHERE CAST(session_id AS TEXT) = CAST(? AS TEXT)
        `;

        db.all(userSql, [sessionId], (err, users) => {
            if (err) users = [];

            const orderSql = `
                SELECT 
                    oi.order_item_id,
                    mi.price,
                    oi.qty as quantity,
                    GROUP_CONCAT(su.user_id) as owner_ids
                FROM ORDER_ITEMS oi
                JOIN ORDERS o ON oi.order_id = o.order_id
                JOIN MENU_ITEMS mi ON oi.menu_item_id = mi.menu_item_id
                LEFT JOIN ORDER_ITEM_OWNERS oio ON oi.order_item_id = oio.order_item_id
                LEFT JOIN SESSION_USERS su ON oio.user_id = su.user_id
                WHERE o.session_id = ?
                GROUP BY oi.order_item_id
            `;

            db.all(orderSql, [sessionId], (err, items) => {
                if (err) items = [];

                let paymentList = [];

                if (users.length > 0) {
                    let userPaymentData = {};

                    users.forEach(u => {
                        userPaymentData[u.user_id] = {
                            user_id: u.user_id,
                            name: u.name,
                            amount: 0,
                            isPaid: u.is_paid === 1
                        };
                    });

                    items.forEach(item => {
                        const itemTotal = item.price * item.quantity;
                        const owners = item.owner_ids ? item.owner_ids.split(',') : [];

                        if (owners.length === 0) {
                            const splitPrice = itemTotal / users.length;
                            users.forEach(u => {
                                userPaymentData[u.user_id].amount += splitPrice;
                            });
                        } else {
                            const splitPrice = itemTotal / owners.length;
                            owners.forEach(uId => {
                                if (userPaymentData[uId]) {
                                    userPaymentData[uId].amount += splitPrice;
                                }
                            });
                        }
                    });

                    paymentList = Object.values(userPaymentData).map(u => {
                        const finalAmount = u.amount.toFixed(2);
                        return {
                            user_id: u.user_id,
                            name: u.name,
                            amount: finalAmount,
                            isPaid: u.isPaid,
                            qrUrl: `https://promptpay.io/${PROMPTPAY_NO}/${finalAmount}.png`
                        };
                    });
                } else {
                    let totalTablePrice = 0;
                    items.forEach(item => {
                        totalTablePrice += (item.price * item.quantity);
                    });

                    if (totalTablePrice > 0) {
                        const finalAmount = totalTablePrice.toFixed(2);
                        paymentList = [{
                            user_id: 0,
                            name: `ลูกค้าโต๊ะ ${tableId} (ชำระรวม)`,
                            amount: finalAmount,
                            isPaid: false,
                            qrUrl: `https://promptpay.io/${PROMPTPAY_NO}/${finalAmount}.png`
                        }];
                    }
                }

                const paidCount = paymentList.filter(p => p.isPaid).length;

                res.render('payment', {
                    tableId: tableId,
                    sessionId: sessionId,
                    paymentList: paymentList,
                    paidCount: paidCount,
                    totalUsers: paymentList.length
                });
            });
        });
    });
});

// สลับสถานะการชำระเงิน (จ่ายแล้ว <-> รอชำระ)
app.post('/cashier/table/:table_id/toggle-user-paid', (req, res) => {
    const { userId, isPaid } = req.body;
    const tableId = req.params.table_id;

    if (userId === '0') {
        return res.redirect(`/cashier/table/${tableId}/payment`);
    }

    const nextStatus = isPaid === 'true' ? 0 : 1;

    db.run(`UPDATE SESSION_USERS SET is_paid = ? WHERE user_id = ?`, [nextStatus, userId], (err) => {
        if (err) console.error('Error updating paid status:', err.message);
        res.redirect(`/cashier/table/${tableId}/payment`);
    });
});

// ปุ่มเสร็จสิ้น (ปิดโต๊ะ + เคลียร์ Active Session ทั้งหมด)
app.post('/cashier/table/:table_id/finish-payment', (req, res) => {
    const tableId = req.params.table_id;

    const updateSessionsSql = `
        UPDATE SESSIONS 
        SET status = 'completed' 
        WHERE LOWER(TRIM(status)) = 'active'
          AND (
            CAST(table_id AS TEXT) = CAST(? AS TEXT)
            OR table_id IN (
                SELECT t2.table_id 
                FROM TABLES t1 
                JOIN TABLES t2 ON t1.table_number = t2.table_number 
                WHERE CAST(t1.table_id AS TEXT) = CAST(? AS TEXT)
            )
          )
    `;

    db.run(updateSessionsSql, [tableId, tableId], (err) => {
        if (err) console.error('[Finish Payment Error] SESSIONS:', err);

        const updateTablesSql = `
            UPDATE TABLES 
            SET status = 'AVAILABLE' 
            WHERE CAST(table_id AS TEXT) = CAST(? AS TEXT)
               OR table_number IN (
                   SELECT table_number FROM TABLES WHERE CAST(table_id AS TEXT) = CAST(? AS TEXT)
               )
        `;

        db.run(updateTablesSql, [tableId, tableId], (err) => {
            if (err) console.error('[Finish Payment Error] TABLES:', err);
            res.redirect('/cashier');
});
    });
});

// -----------------------------------------------------------------------------
// Kitchen routes (mount after DB and middleware)
// -----------------------------------------------------------------------------
app.use(require('./routes/kitchen')(db));

// -----------------------------------------------------------------------------
// Start Server
// -----------------------------------------------------------------------------
app.listen(PORT, () => {
    console.log(`Server is running at http://localhost:${PORT}`);
});