ALTER TABLE ledger_categories
ADD COLUMN is_default INTEGER NOT NULL DEFAULT 0
  CHECK (is_default IN (0, 1));

UPDATE ledger_categories
SET is_default = 1
WHERE (kind = 'income' AND normalized_name IN (
  '工资', '奖金', '投资收益', '兼职', '退款', '红包', '其他'
))
   OR (kind = 'expense' AND normalized_name IN (
  '餐饮', '交通', '购物', '住房', '日用', '娱乐', '医疗', '教育',
  '旅行', '人情', '利息', '手续费', '其他'
));
