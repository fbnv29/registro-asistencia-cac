-- One dated conflict check for all operations that can add occupied hours.
CREATE FUNCTION cac_check_schedule(p_enrollment uuid, p_book uuid,
  p_from date DEFAULT '-infinity', p_to date DEFAULT 'infinity')
RETURNS void LANGUAGE plpgsql AS $$
DECLARE target_teacher uuid; collision record;
BEGIN
  SELECT b.teacher_id INTO target_teacher FROM books b
    WHERE b.id=coalesce(p_book,(SELECT book_id FROM enrollments WHERE id=p_enrollment));
  WITH sessions AS MATERIALIZED (
    SELECT e.id AS enrollment_id,b.id AS book_id,b.teacher_id,s.full_name,b.discipline,
      d.day::date AS day,x.ordinality AS slot,
      d.day::date+(x.value->>'time')::time AS starts,
      d.day::date+(x.value->>'time')::time+make_interval(mins=>b.duration_minutes) AS ends
    FROM enrollments e JOIN students s ON s.id=e.student_id
    JOIN books b ON b.id=e.book_id JOIN periods p ON p.id=b.period_id
    CROSS JOIN LATERAL generate_series(
      greatest(p.start_date,e.joined_on,p_from)::timestamp,
      least(p.end_date,coalesce(e.left_on,p.end_date),p_to)::timestamp,
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
    WHERE (a.enrollment_id=p_enrollment OR a.book_id=p_book)
    ORDER BY a.day,a.starts,b.starts,b.enrollment_id LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'Conflicto de horario del profesor' USING ERRCODE='23P01',
      DETAIL=json_build_object('date',collision.day,'time',to_char(collision.starts,'HH24:MI'),
        'end_time',to_char(collision.ends,'HH24:MI'),'student',collision.full_name,
        'discipline',collision.discipline)::text;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION cac_schedule_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE next_date date; b record; unchanged boolean;
BEGIN
  PERFORM pg_advisory_xact_lock(483723);
  IF TG_TABLE_NAME='schedule_versions' THEN
    IF TG_OP='UPDATE' AND NEW.enrollment_id=OLD.enrollment_id
      AND NEW.effective_from=OLD.effective_from AND NEW.slots=OLD.slots THEN RETURN NEW; END IF;
    IF TG_OP='INSERT' THEN
      SELECT slots=NEW.slots INTO unchanged FROM schedule_versions
        WHERE enrollment_id=NEW.enrollment_id AND effective_from<NEW.effective_from
        ORDER BY effective_from DESC LIMIT 1;
      IF unchanged THEN RETURN NEW; END IF;
    END IF;
    SELECT min(effective_from)-1 INTO next_date FROM schedule_versions
      WHERE enrollment_id=NEW.enrollment_id AND effective_from>NEW.effective_from;
    PERFORM cac_check_schedule(NEW.enrollment_id,NULL,NEW.effective_from,
      coalesce(next_date,'infinity'::date));
  ELSIF TG_TABLE_NAME='enrollments' THEN
    IF TG_OP='INSERT' OR NEW.book_id<>OLD.book_id THEN
      PERFORM cac_check_schedule(NEW.id,NULL);
    ELSE
      -- Check only newly added dates, never unchanged historical classes.
      IF NEW.joined_on<OLD.joined_on THEN
        PERFORM cac_check_schedule(NEW.id,NULL,NEW.joined_on,OLD.joined_on-1);
      END IF;
      IF coalesce(NEW.left_on,'infinity'::date)>coalesce(OLD.left_on,'infinity'::date) THEN
        PERFORM cac_check_schedule(NEW.id,NULL,OLD.left_on+1,
          coalesce(NEW.left_on,'infinity'::date));
      END IF;
    END IF;
  ELSIF TG_TABLE_NAME='books' THEN
    IF NEW.archived_at IS NOT NULL THEN RETURN NEW; END IF;
    IF NEW.teacher_id<>OLD.teacher_id OR NEW.duration_minutes>OLD.duration_minutes THEN
      PERFORM cac_check_schedule(NULL,NEW.id);
    ELSIF OLD.archived_at IS NOT NULL THEN
      PERFORM cac_check_schedule(NULL,NEW.id,(now() AT TIME ZONE 'America/Santiago')::date);
    END IF;
  ELSIF TG_TABLE_NAME='periods' AND NEW.archived_at IS NULL THEN
    FOR b IN SELECT id FROM books WHERE period_id=NEW.id ORDER BY id LOOP
      IF OLD.archived_at IS NOT NULL THEN
        PERFORM cac_check_schedule(NULL,b.id,(now() AT TIME ZONE 'America/Santiago')::date);
      ELSE
        IF NEW.start_date<OLD.start_date THEN
          PERFORM cac_check_schedule(NULL,b.id,NEW.start_date,OLD.start_date-1);
        END IF;
        IF NEW.end_date>OLD.end_date THEN
          PERFORM cac_check_schedule(NULL,b.id,OLD.end_date+1,NEW.end_date);
        END IF;
      END IF;
    END LOOP;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER book_schedule_integrity ON books;
CREATE TRIGGER book_schedule_integrity AFTER UPDATE OF duration_minutes,teacher_id,archived_at
  ON books FOR EACH ROW EXECUTE FUNCTION cac_schedule_guard();
CREATE TRIGGER period_schedule_integrity AFTER UPDATE OF start_date,end_date,archived_at
  ON periods FOR EACH ROW EXECUTE FUNCTION cac_schedule_guard();
