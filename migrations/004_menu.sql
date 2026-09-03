CREATE TABLE IF NOT EXISTS item_modifier_groups (
  item_id  INT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  group_id INT NOT NULL REFERENCES modifier_groups(id) ON DELETE CASCADE,
  sort     INT NOT NULL DEFAULT 0,
  PRIMARY KEY (item_id, group_id)
);

ALTER TABLE modifier_groups
  ADD COLUMN IF NOT EXISTS min_select INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS max_select INT NOT NULL DEFAULT 1;

ALTER TABLE items
  ADD COLUMN IF NOT EXISTS sold_out_until DATE;

-- preserve today's behaviour: every kandar item gets both existing groups
INSERT INTO item_modifier_groups (item_id, group_id)
SELECT i.id, g.id FROM items i CROSS JOIN modifier_groups g WHERE i.kandar
ON CONFLICT DO NOTHING;

UPDATE modifier_groups SET min_select=1, max_select=1 WHERE mode='radio';
UPDATE modifier_groups SET min_select=0, max_select=99 WHERE mode='checkbox';
