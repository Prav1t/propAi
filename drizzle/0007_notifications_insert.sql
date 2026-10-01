-- only the worker (system context) creates notifications for other users; a request context can only notify itself
DROP POLICY IF EXISTS notifications_insert ON notifications;
--> statement-breakpoint
CREATE POLICY notifications_insert ON notifications FOR INSERT
  WITH CHECK (org_id = app_org() AND (user_id = app_user() OR app_system()));
