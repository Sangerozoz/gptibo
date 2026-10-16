ALTER TABLE catalog_plans ADD COLUMN display_label TEXT NOT NULL DEFAULT '' CHECK(length(display_label) <= 20);
UPDATE catalog_plans SET display_label='日常之选' WHERE id='plus';
