// Receipt index shared by the homepage (index.html) and assets/comments.js
// (the left sidebar + Prev/Next on every receipt page). It lives in its own
// plain <script> file so the sidebar still builds when a receipt is opened
// straight from disk -- where fetch('index.html') would be blocked.
// This file is the source of truth: keep every entry a single line and
// update index.html and assets/comments.js together when it changes.
window.RECEIPTS = [
  { name: "Agency Banking Cash In", file: "Agency_Banking_Cashin_Receipt_Customer_Merchant.html", group: "customer" },
  { name: "Agency Banking Cashout", file: "Agency_Banking_Cashout_Receipt_Customer_Merchant.html", group: "customer" },
  { name: "Cash In", file: "Cashin_M-PESA_Receipt_Customer_Merchant.html", group: "customer" },
  { name: "Cashout", file: "Cashout_M-PESA_Receipt_Customer_Merchant.html", group: "customer" },
  { name: "Pay Utility DSTV", file: "Pay_Utility_DSTV_Receipt_Customer_Merchant.html", group: "customer", disabled: true },
  { name: "Pay Utility EEU", file: "Pay_Utility_EEU_Receipt_Customer_Merchant.html", group: "customer" },
  { name: "Pay Utility ET", file: "Pay_Utility_ET_Receipt_Customer_Merchant.html", group: "customer", disabled: true },
  { name: "Pay Utility School", file: "Pay_Utility_School_Receipt_Customer_Merchant.html", group: "customer" },
  { name: "Pay Utility Water", file: "Pay_Utility_Water_Receipt_Customer_Merchant.html", group: "customer" },
  { name: "Agency Banking Cash In", file: "Agency_Banking_Cashin_Receipt_Business_Merchant.html", group: "business" },
  { name: "Agency Banking Cashout", file: "Agency_Banking_Cashout_Receipt_Business_Merchant.html", group: "business" },
  { name: "Cash In", file: "Cashin_Receipt_Business_Merchant.html", group: "business" },
  { name: "Cashout", file: "Cashout_Receipt_Business_Merchant.html", group: "business" },
  { name: "Pay Utility DSTV", file: "Pay_Utility_DSTV_Receipt_Business_Merchant.html", group: "business", disabled: true },
  { name: "Pay Utility EEU", file: "Pay_Utility_EEU_Receipt_Business_Merchant.html", group: "business" },
  { name: "Pay Utility ET", file: "Pay_Utility_ET_Receipt_Business_Merchant.html", group: "business", disabled: true },
  { name: "Pay Utility School", file: "Pay_Utility_School_Receipt_Business_Merchant.html", group: "business" },
  { name: "Pay Utility Water", file: "Pay_Utility_Water_Receipt_Business_Merchant.html", group: "business" },
  { name: "Sell Airtime", file: "Sell_Airtime_Receipt_Business_Merchant.html", group: "business" },
  { name: "Sell Float", file: "Sell_Float_Receipt_Business_Merchant.html", group: "business" },
  { name: "Sell Package", file: "Sell_Package_Receipt_Business_Merchant.html", group: "business" },
  { name: "Distribute Float", file: "Distribute_Float_Receipt_Business_Merchant.html", group: "business" },
  { name: "EVD Print", file: "EVD_Receipt_Business_Merchant.html", group: "business" },
  { name: "Voucher Via SMS", file: "Voucher_Via_SMS_Receipt_Business_Merchant.html", group: "business" },
  { name: "Request Payment", file: "Receive_Payment_Receipt_Business_Merchant.html", group: "business" },
  { name: "Merchant to Bank", file: "Merchant_to_Bank_Receipt_Business_Merchant.html", group: "business" },
  { name: "Merchant to Merchant Transfer", file: "Merchant_to_Merchant_Transfer_Receipt_Business_Merchant.html", group: "business" },
  { name: "Rollup / Collect Balance (Single Store)", file: "Rollup_Collect_Balance_Single_Store_Receipt_Business_Merchant.html", group: "business" },
  { name: "Rollup / Collect Balance (All Stores)", file: "Rollup_Collect_Balance_All_Stores_Receipt_Business_Merchant.html", group: "business" },
];
