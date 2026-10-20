-- ============================================================================
-- Merx — le registre des exceptions RLS couvre `merx`, et les douze y entrent
--
-- Référence : docs/SPEC.md § 2.1 (exception nommée), § 4 (placement des
--             schémas) ; docs/BACKLOG.md E4-06.
--
-- Les trois formes de garde sont nées dans `20261020090000`, qui dit pourquoi.
-- Ici : la colonne de schéma, la fonction d'inscription qui accepte `merx`, et
-- les douze fonctions de `merx` que la règle étendue nomme.
--
-- **Le registre porte désormais le schéma.** Sa clé était le nom nu, ce qui
-- suffisait quand il n'y avait que `public` ; avec deux schémas, deux fonctions
-- homonymes se confondraient — et une entrée pourrait couvrir une fonction qui
-- n'est pas celle qu'on croit, exactement la faute que les règles existent pour
-- attraper. Les six entrées d'avant prennent `public` par défaut.
-- ============================================================================

alter table merx.rls_exception_registry
  add column schema_name text not null default 'public'
  check (schema_name in ('public', 'merx'));

comment on column merx.rls_exception_registry.schema_name is
  'Le schéma de la fonction : public (exposée par PostgREST) ou merx '
  '(outillage, inappelable — mais pas inoffensive, voir E4-06). Défaut public, '
  'pour les six entrées d''avant. SPEC § 2.1.';

alter table merx.rls_exception_registry
  drop constraint rls_exception_registry_pkey;

alter table merx.rls_exception_registry
  add primary key (schema_name, function_name);

comment on table merx.rls_exception_registry is
  'Fonctions security definer de public **et de merx** qui touchent une table '
  'métier hors RLS, avec le garde qui les tient et leur justification. '
  'security definer s''exécute sous postgres, qui porte BYPASSRLS, quel que '
  'soit le schéma : le commerce n''est borné que par le corps. SPEC § 2.1, '
  'E2-04 ; étendu à merx en E4-06. Contrôlé par supabase/tests/conventions.ts.';

comment on column merx.rls_exception_registry.guard is
  'La forme du garde, et chacune se contrôle au corps de la fonction — '
  'current_tenant : merx.current_tenant_id() ; super_admin : '
  'merx.is_super_admin() ; row_tenant : new.tenant_id, la ligne écrite, ou '
  'new.id pour un trigger posé sur tenant ; argument_tenant : un argument dont '
  'le nom contient tenant ; auth_identity : auth.uid() ou l''identifiant de '
  'l''événement d''authentification. Une forme qui ne se contrôle pas serait '
  'une case à cocher, pas un garde.';


-- ----------------------------------------------------------------------------
-- La fonction d'inscription accepte `merx`
--
-- Reprise de sa **dernière** définition, lue au catalogue (CLAUDE.md, E3-02) :
-- un `create or replace` remplace la fonction entière. Elle refusait tout ce
-- qui n'était pas `public` ; elle refuse maintenant tout ce qui n'est ni
-- `public` ni `merx` — une table métier ne vit pas ailleurs (SPEC § 4), donc
-- une fonction d'un troisième schéma est une faute de rangement avant d'être
-- une exception RLS.
-- ----------------------------------------------------------------------------

create or replace function merx.register_rls_exception(
  target        regprocedure,
  guard         merx.rls_exception_guard,
  justification text
)
returns void
language plpgsql
set search_path = ''
as $function$
declare
  target_schema text;
  fn_name       text;
begin
  select n.nspname, p.proname into target_schema, fn_name
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  where p.oid = target;

  if target_schema not in ('public', 'merx') then
    raise exception
      'Le registre des exceptions RLS ne connaît que public et merx : %.%',
      target_schema, fn_name;
  end if;

  insert into merx.rls_exception_registry
    (schema_name, function_name, guard, justification)
  values (target_schema, fn_name, guard, justification);
end;
$function$;

comment on function merx.register_rls_exception(regprocedure, merx.rls_exception_guard, text) is
  'Inscrit une fonction security definer de public ou de merx au registre des '
  'exceptions RLS. SPEC § 2.1, E2-04 ; merx admis en E4-06.';


-- ============================================================================
-- Les douze fonctions de `merx`
--
-- Chaque justification dit ce que la fonction lit, et **ce qui la borne** —
-- reprise de la raison donnée par sa propre migration, pas d'une raison
-- reconstruite après coup.
--
-- Aucune n'est appelable par qui que ce soit : `merx` n'est pas exposé par
-- PostgREST, et les gardes de trigger ne s'exécutent que dans une écriture qui
-- a déjà passé la policy de sa table. C'est ce qui rend le risque faible
-- aujourd'hui ; ce n'est pas ce qui le rend nul, et c'est tout l'objet de
-- l'inscription.
-- ============================================================================

-- ---------------------------------------------------------------- row_tenant
-- Les six gardes de trigger d'E4, et le dépôt par défaut d'E3-02.

select merx.register_rls_exception(
  'merx.require_document_number_shape()', 'row_tenant',
  'Lit device pour comparer la lettre du numéro à celle de l''appareil de la '
  'ligne. Definer parce qu''un employé ne lit pas device (policy restrictive '
  'manage_devices, E1-03) : en invoker le garde ne verrait rien et cesserait de '
  'garder en silence. Borné à new.tenant_id, le commerce de la ligne écrite, '
  'que le with check de tenant_isolation a déjà forcé à celui du jeton. E4-02.');

select merx.register_rls_exception(
  'merx.require_floor_price()', 'row_tenant',
  'Lit variant.floor_price et sale_document.doc_type — en un seul select, sur '
  'le chemin des dix lignes au comptoir — pour opposer le plancher à qui n''a '
  'pas override_price_below_floor, et pour sortir tôt sur un retour (E4-06). '
  'Borné à new.tenant_id, le commerce de la ligne écrite. E4-04.');

select merx.register_rls_exception(
  'merx.require_consistent_totals()', 'row_tenant',
  'Somme les line_total du document à la confirmation : aucun check ne traverse '
  'les lignes. Borné à new.tenant_id et à new.id, donc au document écrit. '
  'E4-04.');

select merx.register_rls_exception(
  'merx.require_transformation_shape()', 'row_tenant',
  'Lit le type et le statut du document d''origine pour tenir la chaîne admise. '
  'Borné à new.tenant_id : un original hors du commerce n''est pas trouvé, le '
  'garde laisse passer, et ce sont la clé composite et la RLS qui refusent — '
  'un garde qui refuserait là tiendrait lieu d''isolation dans le balayage '
  '(E3-01). E4-05.');

select merx.register_rls_exception(
  'merx.require_returnable_quantity()', 'row_tenant',
  'Lit les lignes du bon d''origine et celles des retours déjà faits, pour '
  'qu''un retour ne rende ni plus de quantité ni plus d''avoir que le bon n''en '
  'portait (RÈGLE M3-9) ; lit variant et product pour nommer la variante dans '
  'la phrase du refus, et verrouille le bon d''origine pour que deux retours ne '
  'se croisent pas. Borné à new.tenant_id, le commerce du retour écrit. E4-06.');

select merx.register_rls_exception(
  'merx.require_no_active_return()', 'row_tenant',
  'Cherche un retour non annulé issu du bon qu''on annule : sans lui '
  'l''inversion des mouvements sale recréditerait un stock que le retour avait '
  'déjà rendu. Borné à new.tenant_id, le commerce du bon annulé. E4-06.');

select merx.register_rls_exception(
  'merx.open_default_warehouse()', 'row_tenant',
  'Ouvre l''unique dépôt d''un commerce à sa naissance (SPEC § 2.4) : la table '
  'warehouse n''est jamais exposée, et personne ne doit pouvoir en écrire une '
  'ligne. Trigger sur tenant, donc borné à new.id — la ligne écrite **est** le '
  'commerce. E3-02.');

-- ----------------------------------------------------------- argument_tenant
-- Deux fonctions appelées par les fonctions de `public`, et bornées par
-- l'argument qu'elles en reçoivent ; ce sont leurs appelantes qui portent le
-- droit (super_admin pour create_tenant, current_tenant pour register_device).

select merx.register_rls_exception(
  'merx.next_device_prefix(uuid)', 'argument_tenant',
  'Lit les lettres déjà prises d''un commerce pour en donner la suivante, '
  'jamais recyclée (E1-03). Bornée à target_tenant, que ses deux appelantes '
  'inscrites — public.create_tenant() et public.register_device() — '
  'remplissent, et qui portent le droit. E1-03.');

select merx.register_rls_exception(
  'merx.seed_tenant_settings(uuid)', 'argument_tenant',
  'Pose les réglages par défaut d''un commerce neuf, en base et nulle part '
  'ailleurs (E1-05). Bornée à target_tenant, que public.create_tenant() — '
  'inscrite en super_admin — remplit. Hors de portée de l''application : '
  'l''écran ne crée aucun réglage. E1-05.');

-- ------------------------------------------------------------- auth_identity
-- Les deux fonctions qui précèdent le commerce : elles le trouvent, elles ne
-- s'y bornent pas — un filtre sur le commerce du jeton y serait circulaire.

select merx.register_rls_exception(
  'merx.current_app_user()', 'auth_identity',
  'Rend la fiche app_user de l''appelant, déduite du jeton. Bornée à '
  'auth.uid() : une seule ligne, la sienne. C''est elle qui donne son défaut à '
  'created_by sur toute table conventionnée — le jeton ne porte pas '
  'l''identifiant app_user, donc l''écran ne peut pas le remplir (E3-03). '
  'E1-02.');

select merx.register_rls_exception(
  'merx.custom_access_token(jsonb)', 'auth_identity',
  'Hook Supabase Auth : refuse le jeton d''un compte désactivé, estampille '
  'last_seen_at, puis dépose tenant_id et role dans app_metadata. Elle '
  's''exécute hors session, sous supabase_auth_admin, **avant** qu''un commerce '
  'existe dans le jeton : un filtre sur le commerce du jeton y serait '
  'circulaire. Bornée à l''identifiant de l''événement d''authentification. '
  'SPEC § 2.1 ; E0-03, E1-01, E1-02.');

-- -------------------------------------------------------------- current_tenant
-- Et celle qui se borne comme les fonctions de `public`.

select merx.register_rls_exception(
  'merx.log_audit(public.audit_action, text, uuid, jsonb, jsonb)', 'current_tenant',
  'Le seul chemin d''écriture du journal : commerce et auteur viennent du jeton '
  'signé, jamais des paramètres (RÈGLE M8-1). Non exécutable par '
  'authenticated ; definer parce qu''audit_log est en ajout seul et que ses '
  'privilèges d''écriture sont retirés à tout le monde. Bornée à '
  'merx.current_tenant_id(). E1-04.');
