-- Backstop for dated overlaps across books of the same teacher.
-- API operations also acquire this lock before reading their candidate schedules.
CREATE FUNCTION cac_schedule_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target uuid; target_book uuid; bad boolean;
BEGIN
  PERFORM pg_advisory_xact_lock(483723);
  IF TG_TABLE_NAME='schedule_versions' THEN target:=NEW.enrollment_id;
  ELSIF TG_TABLE_NAME='enrollments' THEN target:=NEW.id;
  ELSE target_book:=NEW.id;
  END IF;
  WITH sessions AS MATERIALIZED (
    SELECT e.id AS enrollment_id,b.id AS book_id,b.teacher_id,d.day::date AS day,
      x.ordinality AS slot,
      d.day::date+(x.value->>'time')::time AS starts,
      d.day::date+(x.value->>'time')::time+make_interval(mins=>b.duration_minutes) AS ends
    FROM enrollments e JOIN books b ON b.id=e.book_id JOIN periods p ON p.id=b.period_id
    CROSS JOIN LATERAL generate_series(greatest(p.start_date,e.joined_on)::timestamp,least(p.end_date,coalesce(e.left_on,p.end_date))::timestamp,interval '1 day') AS d(day)
    CROSS JOIN LATERAL (SELECT slots FROM schedule_versions v WHERE v.enrollment_id=e.id AND v.effective_from<=d.day::date ORDER BY effective_from DESC LIMIT 1) v
    CROSS JOIN LATERAL jsonb_array_elements(v.slots) WITH ORDINALITY AS x(value,ordinality)
    WHERE (x.value->>'day')::int=extract(isodow FROM d.day)::int-1
      AND b.teacher_id=(SELECT bb.teacher_id FROM books bb LEFT JOIN enrollments ee ON ee.book_id=bb.id WHERE ee.id=target OR bb.id=target_book LIMIT 1)
  ) SELECT EXISTS (
    SELECT 1 FROM sessions a JOIN sessions b ON a.teacher_id=b.teacher_id AND a.day=b.day
    AND (a.enrollment_id<>b.enrollment_id OR a.slot<>b.slot)
    AND a.starts<b.ends AND b.starts<a.ends
    WHERE (a.enrollment_id=target OR a.book_id=target_book)
  ) INTO bad;
  IF bad THEN RAISE EXCEPTION 'Conflicto de horario del profesor' USING ERRCODE='23P01'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER schedule_integrity AFTER INSERT OR UPDATE ON schedule_versions FOR EACH ROW EXECUTE FUNCTION cac_schedule_guard();
CREATE TRIGGER enrollment_schedule_integrity AFTER INSERT OR UPDATE OF joined_on,left_on,book_id ON enrollments FOR EACH ROW EXECUTE FUNCTION cac_schedule_guard();
CREATE TRIGGER book_schedule_integrity AFTER UPDATE OF duration_minutes,teacher_id ON books FOR EACH ROW EXECUTE FUNCTION cac_schedule_guard();
