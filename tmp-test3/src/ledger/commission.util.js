"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.COMMISSION_RATE = void 0;
exports.splitFare = splitFare;
// 15%, undercutting Bykea's 20% driver commission — see the positioning notes
// from earlier in this build: winning driver supply from the post-Careem-exit
// pool is the whole point of pricing below the incumbent. Move this to an
// admin-configurable value (per the engineering roadmap's pricing-config
// page) before you need to change it without a redeploy.
exports.COMMISSION_RATE = 0.15;
function splitFare(grossAmount, commissionRate = exports.COMMISSION_RATE) {
    const commissionAmount = Math.round(grossAmount * commissionRate * 100) / 100;
    const netAmount = Math.round((grossAmount - commissionAmount) * 100) / 100;
    return { grossAmount, commissionRate, commissionAmount, netAmount };
}
