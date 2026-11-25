insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'media', 'media', false, 104857600,
  array['image/jpeg', 'image/png', 'image/webp', 'image/gif',
        'video/mp4', 'video/quicktime', 'video/webm', 'audio/wav']
);

create policy media_own_folder on storage.objects for all to authenticated
  using (bucket_id = 'media' and name ~ ('^' || (select auth.uid())::text || '/[0-9a-f]{64}$'))
  with check (bucket_id = 'media' and name ~ ('^' || (select auth.uid())::text || '/[0-9a-f]{64}$'));

create function opengym_private.check_media_quota()
returns trigger
language plpgsql set search_path = ''
as $$
declare
  folder text := split_part(new.name, '/', 1);
  size_bytes bigint := (new.metadata->>'size')::bigint;
  total_bytes bigint;
begin
  -- The preliminary Storage permission check has no actual size yet.
  if size_bytes is null then return new; end if;

  -- Serialize concurrent uploads for this folder before counting the completed rows.
  perform pg_advisory_xact_lock(hashtextextended('opengym-media:' || folder, 0));
  select coalesce(sum((o.metadata->>'size')::bigint), 0) into total_bytes
  from storage.objects o
  where o.bucket_id = 'media' and o.name like folder || '/%';

  -- An AFTER trigger sees the row as written, so an upsert counts only its new size.
  if total_bytes > 209715200 then
    raise exception 'media-quota:%', round((total_bytes - size_bytes) / 1048576.0, 1)
      using errcode = 'OG001';
  end if;
  return new;
end;
$$;

create trigger media_quota after insert or update of metadata, name, bucket_id on storage.objects
  for each row when (new.bucket_id = 'media') execute function opengym_private.check_media_quota();
