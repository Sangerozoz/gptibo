ALTER TABLE support_contacts ADD COLUMN wechat_qr_media_id TEXT REFERENCES direct_media(id);
ALTER TABLE support_contacts ADD COLUMN qq_qr_media_id TEXT REFERENCES direct_media(id);
