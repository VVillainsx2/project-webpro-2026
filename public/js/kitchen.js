/**
 * Kitchen App - Vanilla JavaScript
 * Polling + DOM rendering (textContent for XSS safety)
 * ทำงานร่วมกับ kitchen.css และ kitchen EJS views
 */

const KitchenApp = (function() {
    'use strict';

    // ============================================================
    // State
    // ============================================================
    let currentScope = 'new';           // 'new' | 'accepted'
    let seenItemIds = new Set();        // For highlighting new cards
    let pollingInterval = null;
    let isPolling = false;
    let lastFetchTime = 0;
    let connectionStatus = 'unknown';   // 'connected' | 'disconnected' | 'unknown'

    // ============================================================
    // DOM Elements (cached)
    // ============================================================
    let elements = {};

    // ============================================================
    // Utility Functions
    // ============================================================

    /**
     * แปลงเวลา SQLite (YYYY-MM-DD HH:MM:SS) เป็น ISO string
     * DB เก็บ UTC, server ใช้ UTC -> แปลงเป็น ISO + Z
     */
    function sqliteToISO(sqliteStr) {
        if (!sqliteStr) return null;
        // Replace space with T and add Z for UTC
        return sqliteStr.replace(' ', 'T') + 'Z';
    }

    /**
     * Format time for display (Asia/Bangkok)
     */
    function formatTime(sqliteStr) {
        const iso = sqliteToISO(sqliteStr);
        if (!iso) return '--:--';
        try {
            return new Date(iso).toLocaleTimeString('th-TH', {
                hour: '2-digit',
                minute: '2-digit',
                timeZone: 'Asia/Bangkok'
            });
        } catch {
            return '--:--';
        }
    }

    /**
     * Format wait time (e.g., "รอ 7 นาที") with color change > 10 min
     */
    function formatWaitTime(sqliteStr) {
        const iso = sqliteToISO(sqliteStr);
        if (!iso) return '';
        try {
            const sent = new Date(iso).getTime();
            const now = Date.now();
            const diffMs = now - sent;
            const diffMin = Math.floor(diffMs / 60000);
            if (diffMin < 1) return 'เพิ่งสั่ง';
            return `รอ ${diffMin} นาที`;
        } catch {
            return '';
        }
    }

    /**
     * Get wait time class for styling
     */
    function getWaitTimeClass(sqliteStr) {
        const iso = sqliteToISO(sqliteStr);
        if (!iso) return '';
        try {
            const sent = new Date(iso).getTime();
            const diffMin = Math.floor((Date.now() - sent) / 60000);
            return diffMin > 10 ? 'wait-long' : '';
        } catch {
            return '';
        }
    }

    /**
     * Escape HTML for safe textContent (not needed with textContent but kept for safety)
     */
    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    /**
     * Show toast notification
     */
    function showToast(message, type = 'info') {
        let container = document.querySelector('.toast-container');
        if (!container) {
            container = document.createElement('div');
            container.className = 'toast-container';
            document.body.appendChild(container);
        }

        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        const icons = { success: '✅', error: '❌', warning: '⚠️', info: 'ℹ️' };
        toast.innerHTML = `
            <span class="toast-icon">${icons[type] || icons.info}</span>
            <span class="toast-message">${escapeHtml(message)}</span>
            <button class="toast-close" aria-label="ปิด">&times;</button>
        `;

        toast.querySelector('.toast-close').addEventListener('click', () => toast.remove());
        container.appendChild(toast);

        setTimeout(() => {
            toast.style.animation = 'slideDown 0.3s ease reverse';
            setTimeout(() => toast.remove(), 300);
        }, 5000);
    }

    /**
     * Update connection status indicator
     */
    function updateConnectionStatus(status) {
        connectionStatus = status;
        let el = document.querySelector('.connection-status');
        if (!el) {
            el = document.createElement('div');
            el.className = 'connection-status';
            el.innerHTML = '<span class="connection-dot"></span><span class="connection-text"></span>';
            document.body.appendChild(el);
        }
        el.className = `connection-status ${status} show`;
        el.querySelector('.connection-text').textContent = 
            status === 'connected' ? 'เชื่อมต่อแล้ว' : 
            status === 'disconnected' ? 'ขาดการเชื่อมต่อ' : 'กำลังเชื่อมต่อ...';
    }

    // ============================================================
    // Render Functions
    // ============================================================

    /**
     * Create element with textContent (safe from XSS)
     */
    function createElement(tag, className, textContent) {
        const el = document.createElement(tag);
        if (className) el.className = className;
        if (textContent !== undefined) el.textContent = textContent;
        return el;
    }

    /**
     * Render a single item row
     */
    function renderItemRow(item, isTablePage = false) {
        const li = createElement('li', 'item-row');
        li.dataset.itemId = item.order_item_id;

        // Main content
        const mainDiv = createElement('div', 'item-main');

        const qtySpan = createElement('span', 'item-qty', String(item.qty));
        mainDiv.appendChild(qtySpan);

        const nameSpan = createElement('span', 'item-name', item.name);
        mainDiv.appendChild(nameSpan);

        li.appendChild(mainDiv);

        // Note
        if (item.note && item.note.trim() !== '') {
            const noteDiv = createElement('div', 'item-note', item.note);
            li.appendChild(noteDiv);
        }

        // Wait time (for new orders page)
        if (currentScope === 'new' && item.sent_at) {
            const waitDiv = createElement('div', `wait-time ${getWaitTimeClass(item.sent_at)}`, formatWaitTime(item.sent_at));
            waitDiv.style.fontSize = '0.75rem';
            waitDiv.style.color = getWaitTimeClass(item.sent_at) ? 'var(--accent-red)' : 'var(--text-secondary)';
            waitDiv.style.fontWeight = '600';
            waitDiv.style.marginTop = '4px';
            mainDiv.appendChild(waitDiv);
        }

        // Actions (for table page)
        if (isTablePage) {
            const actionsDiv = createElement('div', 'item-actions');
            if (item.status === 'cooking') {
                const btn = createElement('button', 'btn-status btn-ready', 'ปรุงเสร็จ');
                btn.dataset.itemId = item.order_item_id;
                btn.dataset.status = 'ready';
                btn.type = 'button';
                actionsDiv.appendChild(btn);
            } else if (item.status === 'ready') {
                const btn = createElement('button', 'btn-status btn-cooking', 'ย้อนกลับ (ปรุงต่อ)');
                btn.dataset.itemId = item.order_item_id;
                btn.dataset.status = 'cooking';
                btn.type = 'button';
                actionsDiv.appendChild(btn);
            }
            li.appendChild(actionsDiv);
        }

        return li;
    }

    /**
     * Render a table card
     */
    function renderTableCard(table) {
        const article = createElement('article', 'table-card');
        article.dataset.tableId = table.table_id;
        if (table.oldest_sent_at) article.dataset.oldestSentAt = table.oldest_sent_at;

        // Check if has new items
        const hasNew = table.items.some(item => !seenItemIds.has(item.order_item_id));
        if (hasNew) article.classList.add('new-order');

        // Header
        const header = createElement('header', 'card-header');
        
        const tableInfo = createElement('div', 'table-info');
        const tableNum = createElement('h2', 'table-number', `โต๊ะ ${table.table_number}`);
        tableInfo.appendChild(tableNum);

        if (table.oldest_sent_at) {
            const timeEl = createElement('time', 'order-time', `สั่ง: ${formatTime(table.oldest_sent_at)}`);
            timeEl.dateTime = sqliteToISO(table.oldest_sent_at);
            tableInfo.appendChild(timeEl);
        }
        header.appendChild(tableInfo);

        if (hasNew) {
            const badge = createElement('span', 'new-badge', 'ใหม่');
            header.appendChild(badge);
        }
        article.appendChild(header);

        // Items list
        const ul = createElement('ul', 'items-list');
        table.items.forEach(item => {
            ul.appendChild(renderItemRow(item, false));
        });
        article.appendChild(ul);

        // Footer
        const footer = createElement('footer', 'card-footer');
        if (currentScope === 'new') {
            const btn = createElement('button', 'btn-accept', `รับรายการอาหาร (${table.items.length})`);
            btn.type = 'button';
            btn.dataset.tableId = table.table_id;
            btn.dataset.itemIds = JSON.stringify(table.items.map(i => i.order_item_id));
            footer.appendChild(btn);
        } else {
            const link = createElement('a', 'btn-go-table', `อัปเดตสถานะ (${table.items.length})`);
            link.href = `/kitchen/table/${table.table_id}`;
            footer.appendChild(link);
        }
        article.appendChild(footer);

        // Update seen items
        table.items.forEach(item => seenItemIds.add(item.order_item_id));

        return article;
    }

    /**
     * Render table page (kitchen-table.ejs)
     */
    function renderTablePage(data) {
        const { cookingItems, readyItems } = data;

        // Cooking items
        const cookingList = document.querySelector('.cooking-section .items-list');
        if (cookingList) {
            cookingList.innerHTML = '';
            cookingItems.forEach(item => {
                cookingList.appendChild(renderItemRow(item, true));
            });
            const emptySection = cookingList.parentElement.querySelector('.empty-section');
            if (emptySection) emptySection.style.display = cookingItems.length ? 'none' : 'block';
        }

        // Ready items
        const readyList = document.querySelector('.ready-section .items-list');
        if (readyList) {
            readyList.innerHTML = '';
            readyItems.forEach(item => {
                readyList.appendChild(renderItemRow(item, true));
            });
            const emptySection = readyList.parentElement.querySelector('.empty-section');
            if (emptySection) emptySection.style.display = readyItems.length ? 'none' : 'block';
        }

        // Update section titles count
        const cookingTitle = document.querySelector('.cooking-section .section-title');
        if (cookingTitle) cookingTitle.textContent = `🍳 กำลังปรุง (${cookingItems.length})`;
        
        const readyTitle = document.querySelector('.ready-section .section-title');
        if (readyTitle) readyTitle.textContent = `✅ พร้อมเสิร์ฟ (${readyItems.length})`;
    }

    /**
     * Render all tables from API response
     */
    function renderTables(tables) {
        const grid = document.getElementById('table-grid');
        const emptyState = document.querySelector('.empty-state');

        if (!tables || tables.length === 0) {
            if (grid) grid.innerHTML = '';
            if (emptyState) emptyState.style.display = 'flex';
            return;
        }

        if (emptyState) emptyState.style.display = 'none';
        if (!grid) return;

        // Clear and re-render
        grid.innerHTML = '';
        tables.forEach(table => {
            grid.appendChild(renderTableCard(table));
        });
    }

    // ============================================================
    // API Calls
    // ============================================================

    async function fetchOrders(scope) {
        const url = `/api/kitchen/orders?scope=${encodeURIComponent(scope)}`;
        try {
            const response = await fetch(url);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const data = await response.json();
            updateConnectionStatus('connected');
            return data;
        } catch (err) {
            console.error('[Kitchen] Fetch error:', err);
            updateConnectionStatus('disconnected');
            throw err;
        }
    }

    async function apiAccept(itemIds) {
        const response = await fetch('/api/kitchen/accept', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ order_item_ids: itemIds })
        });
        const data = await response.json();
        if (!response.ok) {
            if (response.status === 409) throw new Error(data.message || 'มีคนรับไปแล้ว');
            throw new Error(data.message || 'รับงานไม่สำเร็จ');
        }
        return data;
    }

    async function apiUpdateStatus(itemId, status) {
        const response = await fetch(`/api/kitchen/item/${itemId}/status`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status })
        });
        const data = await response.json();
        if (!response.ok) {
            if (response.status === 409) throw new Error(data.message || 'สถานะเปลี่ยนไปแล้ว');
            throw new Error(data.message || 'อัปเดตสถานะไม่สำเร็จ');
        }
        return data;
    }

    // ============================================================
    // Polling
    // ============================================================

    async function pollOrders() {
        if (isPolling) return; // Skip if previous fetch not done
        isPolling = true;
        lastFetchTime = Date.now();

        try {
            const data = await fetchOrders(currentScope);
            if (data.success && data.tables) {
                if (currentScope === 'new' || currentScope === 'accepted') {
                    renderTables(data.tables);
                    attachCardListeners();
                }
            }
        } catch (err) {
            // Error already shown in connection status
        } finally {
            isPolling = false;
        }
    }

    function startPolling() {
        if (pollingInterval) clearInterval(pollingInterval);
        // Initial fetch
        pollOrders();
        // Then every 4 seconds
        pollingInterval = setInterval(pollOrders, 4000);
    }

    function stopPolling() {
        if (pollingInterval) {
            clearInterval(pollingInterval);
            pollingInterval = null;
        }
    }

    // ============================================================
    // Event Handlers
    // ============================================================

    function handleAcceptClick(event) {
        const btn = event.target.closest('.btn-accept');
        if (!btn) return;

        const itemIds = JSON.parse(btn.dataset.itemIds || '[]');
        if (itemIds.length === 0) return;

        // Disable button during request
        btn.disabled = true;
        const originalText = btn.textContent;
        btn.textContent = 'กำลังรับ...';

        apiAccept(itemIds)
            .then(result => {
                showToast(`รับรายการสำเร็จ ${result.accepted} รายการ`, 'success');
                // Refresh immediately
                pollOrders();
            })
            .catch(err => {
                showToast(err.message, 'error');
                // Refresh to show current state
                pollOrders();
            })
            .finally(() => {
                btn.disabled = false;
                btn.textContent = originalText;
            });
    }

    function handleStatusClick(event) {
        const btn = event.target.closest('.btn-status');
        if (!btn) return;

        const itemId = parseInt(btn.dataset.itemId);
        const newStatus = btn.dataset.status;
        if (!itemId || !newStatus) return;

        btn.disabled = true;
        const originalText = btn.textContent;
        btn.textContent = 'กำลังอัปเดต...';

        apiUpdateStatus(itemId, newStatus)
            .then(result => {
                showToast(`เปลี่ยนสถานะเป็น ${result.status} แล้ว`, 'success');
                // Re-fetch table page data
                fetchTablePageData();
            })
            .catch(err => {
                showToast(err.message, 'error');
                fetchTablePageData();
            })
            .finally(() => {
                btn.disabled = false;
                btn.textContent = originalText;
            });
    }

    async function fetchTablePageData() {
        // For table page, we need to re-fetch from server
        // The page will be re-rendered by the server on navigation
        // But for AJAX, we can call the view endpoint
        try {
            // Simple approach: reload the page section via fetch
            // But since we're on table page, we can just re-fetch the API
            // and manually update (or rely on server-side render on nav)
            // For now, just reload the page to keep it simple
            // In production, you'd have a dedicated API for table page
            window.location.reload();
        } catch (err) {
            console.error('Failed to refresh table page:', err);
        }
    }

    function attachCardListeners() {
        // Accept buttons
        document.querySelectorAll('.btn-accept').forEach(btn => {
            btn.removeEventListener('click', handleAcceptClick);
            btn.addEventListener('click', handleAcceptClick);
        });
        // Status buttons (table page)
        document.querySelectorAll('.btn-status').forEach(btn => {
            btn.removeEventListener('click', handleStatusClick);
            btn.addEventListener('click', handleStatusClick);
        });
    }

    // ============================================================
    // Page Initialization
    // ============================================================

    function init(scope) {
        currentScope = scope;
        console.log('[KitchenApp] Initialized for scope:', scope);

        // Start polling for list pages
        if (scope === 'new' || scope === 'accepted') {
            startPolling();
        }

        // Attach listeners for existing buttons
        attachCardListeners();

        // Handle page visibility change (pause polling when hidden)
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) {
                stopPolling();
            } else {
                startPolling();
            }
        });
    }

    function initTablePage() {
        console.log('[KitchenApp] Initialized table page');
        // Attach status button listeners
        attachCardListeners();
    }

    // ============================================================
    // Public API
    // ============================================================
    return {
        init,
        initTablePage,
        startPolling,
        stopPolling,
        pollOrders,
        showToast,
        formatTime,
        sqliteToISO
    };
})();

// Export for module systems (not used here but good practice)
if (typeof module !== 'undefined' && module.exports) {
    module.exports = KitchenApp;
}