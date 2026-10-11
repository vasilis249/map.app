-- Seed users for the browser flows (password for all: test-pass-1). Ids are fixed: the flows use them.
INSERT INTO auth.users (id, email, raw_user_meta_data, local_password) VALUES
  ('11111111-0000-0000-0000-000000000001', 'me@test', '{"age_confirmed":true,"full_name":"Βασίλης Χαρ", "username":"vasilis"}', encode(sha256('test-pass-1'), 'hex')),
  ('22222222-0000-0000-0000-000000000002', 'maria@test', '{"age_confirmed":true,"full_name":"Μαρία Παπαδοπούλου"}', encode(sha256('test-pass-1'), 'hex')),
  ('33333333-0000-0000-0000-000000000003', 'nikos@test', '{"age_confirmed":true,"full_name":"Νίκος Γεωργίου"}', encode(sha256('test-pass-1'), 'hex')),
  ('44444444-0000-0000-0000-000000000004', 'giorgos@test', '{"age_confirmed":true,"full_name":"Γιώργος Κ."}', encode(sha256('test-pass-1'), 'hex')),
  ('55555555-0000-0000-0000-000000000005', 'eleni@test', '{"age_confirmed":true,"full_name":"Ελένη Μ."}', encode(sha256('test-pass-1'), 'hex'));
-- me ↔ nikos mutual (friends), maria follows me, I follow eleni (follow notifications come from the trigger)
INSERT INTO public.follows (follower_id, followee_id) VALUES
  ('11111111-0000-0000-0000-000000000001','33333333-0000-0000-0000-000000000003'),
  ('33333333-0000-0000-0000-000000000003','11111111-0000-0000-0000-000000000001'),
  ('22222222-0000-0000-0000-000000000002','11111111-0000-0000-0000-000000000001'),
  ('11111111-0000-0000-0000-000000000001','55555555-0000-0000-0000-000000000005');
