ALTER TABLE pactaris.accounts
 ADD COLUMN preferred_display_name text
 CHECK (preferred_display_name IS NULL OR (
   char_length(preferred_display_name) BETWEEN 1 AND 80
   AND preferred_display_name !~ '[[:cntrl:]]'
 ));
