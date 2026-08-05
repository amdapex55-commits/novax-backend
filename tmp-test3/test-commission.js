"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const commission_util_1 = require("./src/ledger/commission.util");
function assertEqual(actual, expected, label) {
    if (Math.abs(actual - expected) > 0.001) {
        console.error(`FAIL: ${label} — got ${actual}, expected ${expected}`);
        process.exitCode = 1;
    }
    else {
        console.log(`OK: ${label} — ${actual}`);
    }
}
console.log("COMMISSION_RATE:", commission_util_1.COMMISSION_RATE);
// Typical fare
let s = (0, commission_util_1.splitFare)(200);
assertEqual(s.commissionAmount, 30, "commission on 200 @ 15%");
assertEqual(s.netAmount, 170, "net payout on 200 @ 15%");
assertEqual(s.grossAmount + 0, 200, "gross unchanged");
assertEqual(s.netAmount + s.commissionAmount, s.grossAmount, "net + commission == gross (200)");
// Fractional fare (fare estimates round to whole rupees upstream, but the
// split itself must still hold to the cent for any value that reaches it)
s = (0, commission_util_1.splitFare)(133);
assertEqual(s.netAmount + s.commissionAmount, s.grossAmount, "net + commission == gross (133, fractional case)");
// Zero fare (shouldn't happen given fare.util's base fare floor, but must not
// divide/crash if it ever does)
s = (0, commission_util_1.splitFare)(0);
assertEqual(s.commissionAmount, 0, "commission on 0");
assertEqual(s.netAmount, 0, "net on 0");
// Custom rate override
s = (0, commission_util_1.splitFare)(100, 0.20);
assertEqual(s.commissionAmount, 20, "commission on 100 @ 20% override");
assertEqual(s.netAmount, 80, "net on 100 @ 20% override");
console.log(process.exitCode === 1 ? "SOME CHECKS FAILED" : "ALL CHECKS PASSED");
