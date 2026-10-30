-- Validate only the dates affected by a schedule version, not its historical classes.
CREATE OR REPLACE FUNCTION cac_schedule_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target uuid; target_book uuid; target_teacher uuid;
  affected_from date := '-infinity'; affected_to date := 'infinity';
  collision record;
BEGIN
  PERFORM pg_advisory_xact_lock(483723);
  IF TG_TABLE_NAME='schedule_versions' THEN
    target := NEW.enrollment_id;
    affected_from := NEW.effective_from;
    SELECT min(effective_from)-1 INTO affected_to FROM schedule_versions
      WHERE enrollment_id=target AND effective_from>NEW.effective_from;
    affected_to := coalesce(affected_to, 'infinity'::date);
  ELSIF TG_TABLE_NAME='enrollments' THEN
    target := NEW.id;
    -- A withdrawal or later start only removes classes; it cannot introduce a conflict.
    IF TG_OP='UPDATE' AND NEW.book_id=OLD.book_id
      AND NEW.joined_on>=OLD.joined_on
      AND coalesce(NEW.left_on,'infinity'::date)<=coalesce(OLD.left_on,'infinity'::date)
    THEN RETURN NEW; END IF;
    IF TG_OP='UPDATE' AND NEW.book_id=OLD.book_id AND NEW.joined_on=OLD.joined_on
      AND OLD.left_on IS NOT NULL THEN affected_from := OLD.left_on+1; END IF;
  ELSE
    target_book := NEW.id;
  END IF;
  SELECT b.teacher_id INTO target_teacher FROM books b
    WHERE b.id=coalesce(target_book,(SELECT book_id FROM enrollments WHERE id=target));
  WITH sessions AS MATERIALIZED (
    SELECT e.id AS enrollment_id,b.id AS book_id,b.teacher_id,s.full_name,b.discipline,
      d.day::date AS day,x.ordinality AS slot,
      d.day::date+(x.value->>'time')::time AS starts,
      d.day::date+(x.value->>'time')::time+make_interval(mins=>b.duration_minutes) AS ends
    FROM enrollments e JOIN students s ON s.id=e.student_id
    JOIN books b ON b.id=e.book_id JOIN periods p ON p.id=b.period_id
    CROSS JOIN LATERAL generate_series(
      greatest(p.start_date,e.joined_on,affected_from)::timestamp,
      least(p.end_date,coalesce(e.left_on,p.end_date),affected_to)::timestamp,
      interval '1 day') AS d(day)
    CROSS JOIN LATERAL (SELECT slots FROM schedule_versions v
      WHERE v.enrollment_id=e.id AND v.effective_from<=d.day::date
      ORDER BY effective_from DESC LIMIT 1) v
    CROSS JOIN LATERAL jsonb_array_elements(v.slots) WITH ORDINALITY AS x(value,ordinality)
    WHERE (x.value->>'day')::int=extract(isodow FROM d.day)::int-1
      AND b.teacher_id=target_teacher AND b.archived_at IS NULL AND p.archived_at IS NULL
  )
  SELECT b.* INTO collision FROM sessions a JOIN sessions b
    ON a.teacher_id=b.teacher_id AND a.day=b.day
    AND (a.enrollment_id<>b.enrollment_id OR a.slot<>b.slot)
    AND a.starts<b.ends AND b.starts<a.ends
    WHERE (a.enrollment_id=target OR a.book_id=target_book)
    ORDER BY a.day,a.starts,b.starts,b.enrollment_id LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'Conflicto de horario del profesor' USING ERRCODE='23P01',
      DETAIL=json_build_object('date',collision.day,'time',to_char(collision.starts,'HH24:MI'),
        'end_time',to_char(collision.ends,'HH24:MI'),'student',collision.full_name,
        'discipline',collision.discipline)::text;
  END IF;
  RETURN NEW;
END $$;
