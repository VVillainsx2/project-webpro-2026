/**
 * Status library สำหรับฝั่งครัวและเสิร์ฟ (ใช้ร่วมกัน)
 * ตาม PRD หัวข้อ 6: โมเดลสถานะ
 * pending -> ordered -> cooking -> ready -> served
 */

const STATUS = {
    PENDING: 'pending',
    ORDERED: 'ordered',
    COOKING: 'cooking',
    READY: 'ready',
    SERVED: 'served'
};

// role -> { จากสถานะ: [ไปสถานะที่อนุญาต] }
const TRANSITIONS = {
    kitchen: {
        [STATUS.ORDERED]: [STATUS.COOKING],
        [STATUS.COOKING]: [STATUS.READY],
        [STATUS.READY]: [STATUS.COOKING]  // ย้อนกลับได้เฉพาะ ready -> cooking (ยังไม่ served)
    },
    waiter: {
        [STATUS.READY]: [STATUS.SERVED]
    }
};

/**
 * ตรวจสอบว่าสามารถเปลี่ยนสถานะได้หรือไม่
 * @param {string} role - 'kitchen' | 'waiter'
 * @param {string} from - สถานะปัจจุบัน
 * @param {string} to - สถานะที่ต้องการ
 * @returns {boolean}
 */
function canTransition(role, from, to) {
    const allowed = TRANSITIONS[role];
    if (!allowed) return false;
    const fromTransitions = allowed[from];
    if (!fromTransitions) return false;
    return fromTransitions.includes(to);
}

/**
 * ตรวจสอบลำดับสถานะ (สำหรับ validation เพิ่มเติม)
 * @param {string} from
 * @param {string} to
 * @returns {boolean}
 */
function isValidOrder(from, to) {
    const order = [STATUS.PENDING, STATUS.ORDERED, STATUS.COOKING, STATUS.READY, STATUS.SERVED];
    const fromIdx = order.indexOf(from);
    const toIdx = order.indexOf(to);
    return fromIdx !== -1 && toIdx !== -1 && toIdx > fromIdx;
}

module.exports = {
    STATUS,
    TRANSITIONS,
    canTransition,
    isValidOrder
};