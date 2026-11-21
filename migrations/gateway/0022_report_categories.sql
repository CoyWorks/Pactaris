-- Reports are mostly about the app itself (owner decision, 21 November 2026): bug, account and
-- suggestion join the existing categories. Older abuse categories stay valid for reports already filed.
ALTER TABLE pactaris.abuse_reports DROP CONSTRAINT abuse_reports_category_check;
ALTER TABLE pactaris.abuse_reports ADD CONSTRAINT abuse_reports_category_check CHECK(category IN
 ('bug','account','suggestion','minorSafety','other','harassment','unwantedInvitation','nonConsensual','impersonation','spam'));
