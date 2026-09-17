ALTER TABLE ledger_settings ADD COLUMN account_icon_default TEXT NOT NULL DEFAULT 'wallet';
ALTER TABLE ledger_settings ADD COLUMN account_icon_available_json TEXT NOT NULL DEFAULT '["wallet","credit_card","cash","building_bank","briefcase","custom_builtin_boc","custom_builtin_icbc","custom_builtin_cmb","custom_builtin_abc","custom_builtin_psbc","custom_builtin_ccb","custom_builtin_wechat_pay","custom_builtin_alipay","custom_builtin_unionpay"]';
ALTER TABLE ledger_settings ADD COLUMN account_icon_custom_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE ledger_settings ADD COLUMN account_icon_names_json TEXT NOT NULL DEFAULT '{}';
