// POST /api/admin/auth/logout — clears the admin session cookie.
"use strict";
const { clearCookieHeader } = require("../../lib/admin-auth");

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    res.status(405).json({ ok: false, error: "method not allowed" });
    return;
  }
  res.setHeader("Set-Cookie", clearCookieHeader());
  res.status(200).json({ ok: true });
};
