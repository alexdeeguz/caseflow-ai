-- Fictional case stubs only. Re-running seeds never resets assignments or profiles.
insert into caseflow.cases(id,title,summary) values
('10000000-0000-4000-8000-000000000001','Demo: Harbor Avenue collision','Fictional vehicle collision for demonstrating case access. No real client information.'),
('10000000-0000-4000-8000-000000000002','Demo: Market Street slip and fall','Fictional premises incident for demonstrating staff assignments.'),
('10000000-0000-4000-8000-000000000003','Demo: Bayside bicycle incident','Fictional bicycle incident for demonstrating permission boundaries.')
on conflict(id) do nothing;
