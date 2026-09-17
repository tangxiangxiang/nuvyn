-- Refresh the default Ledger category catalog without changing transaction
-- references. Existing renamed categories keep their stable IDs.
ALTER TABLE ledger_categories
ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 1000
  CHECK (typeof(sort_order) = 'integer' AND sort_order >= 0);

CREATE INDEX idx_ledger_categories_kind_archived_sort
  ON ledger_categories(kind, archived_at, sort_order, normalized_name, id);

UPDATE ledger_categories
SET name = '红包 / 礼金',
    normalized_name = '红包 / 礼金',
    version = version + 1
WHERE kind = 'income'
  AND normalized_name = '红包'
  AND is_default = 1
  AND NOT EXISTS (
    SELECT 1
    FROM ledger_categories AS target
    WHERE target.kind = 'income'
      AND target.normalized_name = '红包 / 礼金'
  );

UPDATE ledger_categories
SET name = '人情往来',
    normalized_name = '人情往来',
    version = version + 1
WHERE kind = 'expense'
  AND normalized_name = '人情'
  AND is_default = 1
  AND NOT EXISTS (
    SELECT 1
    FROM ledger_categories AS target
    WHERE target.kind = 'expense'
      AND target.normalized_name = '人情往来'
  );

UPDATE ledger_categories
SET is_default = 1,
    sort_order = 1,
    icon = COALESCE(NULLIF(icon, 'wallet'), 'custom_builtin_category_income_salary')
WHERE kind = 'income' AND normalized_name = '工资';

UPDATE ledger_categories
SET is_default = 1,
    sort_order = 2,
    icon = COALESCE(NULLIF(icon, 'wallet'), 'custom_builtin_category_income_bonus')
WHERE kind = 'income' AND normalized_name = '奖金';

UPDATE ledger_categories
SET is_default = 1,
    sort_order = 3,
    icon = COALESCE(NULLIF(icon, 'wallet'), 'custom_builtin_category_income_part_time')
WHERE kind = 'income' AND normalized_name = '兼职';

UPDATE ledger_categories
SET is_default = 1,
    sort_order = 4,
    icon = COALESCE(NULLIF(icon, 'wallet'), 'custom_builtin_category_income_investment')
WHERE kind = 'income' AND normalized_name = '投资收益';

UPDATE ledger_categories
SET is_default = 1,
    sort_order = 5,
    icon = COALESCE(NULLIF(icon, 'wallet'), 'custom_builtin_category_income_red_packet')
WHERE kind = 'income' AND normalized_name = '红包 / 礼金';

UPDATE ledger_categories
SET is_default = 1,
    sort_order = 6,
    icon = COALESCE(NULLIF(icon, 'wallet'), 'custom_builtin_category_income_refund')
WHERE kind = 'income' AND normalized_name = '退款';

UPDATE ledger_categories
SET is_default = 1,
    sort_order = 7,
    icon = COALESCE(NULLIF(icon, 'wallet'), 'custom_builtin_category_income_other')
WHERE kind = 'income' AND normalized_name = '其他';

UPDATE ledger_categories
SET is_default = 1,
    sort_order = 1,
    icon = COALESCE(NULLIF(icon, 'wallet'), 'custom_builtin_category_expense_food')
WHERE kind = 'expense' AND normalized_name = '餐饮';

UPDATE ledger_categories
SET is_default = 1,
    sort_order = 2,
    icon = COALESCE(NULLIF(icon, 'wallet'), 'custom_builtin_category_expense_transport')
WHERE kind = 'expense' AND normalized_name = '交通';

UPDATE ledger_categories
SET is_default = 1,
    sort_order = 3,
    icon = COALESCE(NULLIF(icon, 'wallet'), 'custom_builtin_category_expense_shopping')
WHERE kind = 'expense' AND normalized_name = '购物';

UPDATE ledger_categories
SET is_default = 1,
    sort_order = 4,
    icon = COALESCE(NULLIF(icon, 'wallet'), 'custom_builtin_category_expense_daily')
WHERE kind = 'expense' AND normalized_name = '日用';

UPDATE ledger_categories
SET is_default = 1,
    sort_order = 5,
    icon = COALESCE(NULLIF(icon, 'wallet'), 'custom_builtin_category_expense_home')
WHERE kind = 'expense' AND normalized_name = '住房';

INSERT OR IGNORE INTO ledger_categories (
  id, kind, name, normalized_name, system_key, icon, is_default, sort_order,
  archived_at, version, created_at, updated_at
)
SELECT 'custom_builtin_category_expense_communication', 'expense', '通讯', '通讯', NULL,
       'custom_builtin_category_expense_communication', 1, 6, NULL, 1, 0, 0
WHERE EXISTS (SELECT 1 FROM ledger_settings WHERE singleton_id = 1)
  AND NOT EXISTS (
    SELECT 1 FROM ledger_categories
    WHERE kind = 'expense' AND normalized_name = '通讯'
  );

INSERT OR IGNORE INTO ledger_categories (
  id, kind, name, normalized_name, system_key, icon, is_default, sort_order,
  archived_at, version, created_at, updated_at
)
SELECT 'custom_builtin_category_expense_subscription', 'expense', '订阅', '订阅', NULL,
       'custom_builtin_category_expense_subscription', 1, 7, NULL, 1, 0, 0
WHERE EXISTS (SELECT 1 FROM ledger_settings WHERE singleton_id = 1)
  AND NOT EXISTS (
    SELECT 1 FROM ledger_categories
    WHERE kind = 'expense' AND normalized_name = '订阅'
  );

UPDATE ledger_categories
SET is_default = 1,
    sort_order = 8,
    icon = COALESCE(NULLIF(icon, 'wallet'), 'custom_builtin_category_expense_entertainment')
WHERE kind = 'expense' AND normalized_name = '娱乐';

UPDATE ledger_categories
SET is_default = 1,
    sort_order = 9,
    icon = COALESCE(NULLIF(icon, 'wallet'), 'custom_builtin_category_expense_medical')
WHERE kind = 'expense' AND normalized_name = '医疗';

UPDATE ledger_categories
SET is_default = 1,
    sort_order = 10,
    icon = COALESCE(NULLIF(icon, 'wallet'), 'custom_builtin_category_expense_education')
WHERE kind = 'expense' AND normalized_name = '教育';

UPDATE ledger_categories
SET is_default = 1,
    sort_order = 11,
    icon = COALESCE(NULLIF(icon, 'wallet'), 'custom_builtin_category_expense_travel')
WHERE kind = 'expense' AND normalized_name = '旅行';

UPDATE ledger_categories
SET is_default = 1,
    sort_order = 12,
    icon = COALESCE(NULLIF(icon, 'wallet'), 'custom_builtin_category_expense_gift')
WHERE kind = 'expense' AND normalized_name = '人情往来';

INSERT OR IGNORE INTO ledger_categories (
  id, kind, name, normalized_name, system_key, icon, is_default, sort_order,
  archived_at, version, created_at, updated_at
)
SELECT 'custom_builtin_category_expense_insurance', 'expense', '保险', '保险', NULL,
       'custom_builtin_category_expense_insurance', 1, 13, NULL, 1, 0, 0
WHERE EXISTS (SELECT 1 FROM ledger_settings WHERE singleton_id = 1)
  AND NOT EXISTS (
    SELECT 1 FROM ledger_categories
    WHERE kind = 'expense' AND normalized_name = '保险'
  );

UPDATE ledger_categories
SET is_default = 1,
    sort_order = 14,
    icon = COALESCE(NULLIF(icon, 'wallet'), 'custom_builtin_category_expense_interest')
WHERE kind = 'expense' AND normalized_name = '利息';

UPDATE ledger_categories
SET is_default = 1,
    sort_order = 15,
    icon = COALESCE(NULLIF(icon, 'wallet'), 'custom_builtin_category_expense_fee')
WHERE kind = 'expense' AND normalized_name = '手续费';

UPDATE ledger_categories
SET is_default = 1,
    sort_order = 16,
    icon = COALESCE(NULLIF(icon, 'wallet'), 'custom_builtin_category_expense_other')
WHERE kind = 'expense' AND normalized_name = '其他';
