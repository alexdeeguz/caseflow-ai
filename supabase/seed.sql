-- Re-running seeds preserves existing cases, assignments, and profiles.
insert into caseflow.cases(id, title, client_name, incident_date, status, summary) values
('10000000-0000-4000-8000-000000000001', 'Demo: Harbor Avenue collision', 'Jordan Ellis', '2026-08-12', 'intake', 'Fictional vehicle collision for demonstrating case access. No real client information.'),
('10000000-0000-4000-8000-000000000002', 'Demo: Market Street slip and fall', 'Morgan Reed', '2026-09-03', 'intake', 'Fictional premises incident for demonstrating staff assignments.'),
('10000000-0000-4000-8000-000000000003', 'Demo: Bayside bicycle incident', 'Taylor Brooks', '2026-10-18', 'intake', 'Fictional bicycle incident for demonstrating permission boundaries.')
on conflict(id) do nothing;
