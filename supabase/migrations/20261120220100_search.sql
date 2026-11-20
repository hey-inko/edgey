-- Search from live rows under the caller's RLS policies. No copied index
-- table can retain a row after its publication or verification is withdrawn.
create function public.search_blades(query_text text)
returns table (
  match_type text,
  requires_choice boolean,
  score real,
  matched_code text,
  variant_id uuid,
  product_slug text,
  sku text
)
language sql
stable
security invoker
set search_path = ''
as $$
  with q as (
    select public.normalise_code(left(query_text, 80)) as code,
           btrim(public.fold_text(left(query_text, 80))) as words
  ),
  exact_candidates as (
    select v.id, v.sku as printed, 0 as priority
    from public.variants v, q
    where q.code <> '' and v.publication_status = 'published' and v.sku_normalised = q.code
    union all
    select v.id, c.code, 1
    from public.compatibility c
    join public.variants v on v.id = c.variant_id, q
    where q.code <> '' and v.publication_status = 'published'
      and c.verification_state = 'approved' and not c.is_private and c.code_normalised = q.code
    union all
    select v.id, p.family_code, 2
    from public.products p
    join public.variants v on v.product_id = p.id, q
    where q.code <> '' and v.publication_status = 'published' and public.normalise_code(p.family_code) = q.code
  ),
  exact as materialized (
    select distinct on (id) id, printed
    from exact_candidates
    order by id, priority, printed
  ),
  words as (
    select distinct token
    from q, regexp_split_to_table(q.words, '\s+') as token
    where token <> ''
  ),
  corpus as (
    select v.id, public.fold_text(concat_ws(' ',
      v.option_label, v.tool, p.name, tc.name, material.words, fit.words
    )) as document,
    array[public.normalise_code(p.family_code), v.sku_normalised] || coalesce(fit.codes, '{}') as codes
    from public.variants v
    join public.products p on p.id = v.product_id
    join public.tool_categories tc on tc.slug = p.tool_category
    left join lateral (
      select string_agg(s.name, ' ') as words
      from public.variant_substrates vs join public.substrates s on s.slug = vs.substrate
      where vs.variant_id = v.id
    ) material on true
    left join lateral (
      select string_agg(concat_ws(' ', b.name, c.machine, c.tool, c.adapter), ' ') as words,
             array_agg(c.code_normalised) as codes
      from public.compatibility c left join public.brands b on b.slug = c.brand
      where c.variant_id = v.id and c.verification_state = 'approved' and not c.is_private
    ) fit on true
    where v.publication_status = 'published'
      and not exists (select 1 from exact)
      and exists (select 1 from words)
  ),
  word_scores as (
    select s.id,
      case
        when w.token ~ '[0-9]' then
          case when public.normalise_code(w.token) = any(s.codes) then 1.0 end
        when length(w.token) < 2 then null
        when w.token = any(string_to_array(s.document, ' ')) then 1.0
        when strpos(s.document, w.token) > 0 then 0.8
        when length(w.token) >= 4 and extensions.word_similarity(w.token, s.document) >= 0.5
          then extensions.word_similarity(w.token, s.document) * 0.7
      end as score
    from corpus s cross join words w
  ),
  matches as (
    select id, 'exact'::text as match_type, count(*) over () > 1 as requires_choice,
           1::real as score, printed
    from exact
    union all
    select id, 'suggested', false, avg(score)::real, null
    from word_scores
    group by id having count(*) = count(score)
  )
  select m.match_type, m.requires_choice, m.score, m.printed, v.id, p.slug, v.sku
  from matches m
  join public.variants v on v.id = m.id
  join public.products p on p.id = v.product_id
  order by m.score desc, p.sort_order, p.slug, v.sort_order, v.sku;
$$;

revoke all on function public.search_blades(text) from public;
grant execute on function public.search_blades(text) to anon, authenticated, service_role;
