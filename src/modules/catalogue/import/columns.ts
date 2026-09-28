/*
 * Les champs importables, et la correspondance des colonnes. M1 — E2-05.
 *
 * BACKLOG E2-05 : « écran de correspondance des colonnes, avec proposition
 * automatique ». La proposition est ce qui décide du temps que l'import
 * coûte : bien devinée, le patron relit et valide ; mal devinée, il désigne
 * dix colonnes à la main, et c'est là qu'il referme le fichier.
 *
 * Les en-têtes sont donc comparés sous une forme pliée — minuscules, sans
 * accents, sans ponctuation — à une liste de ce qu'un commerçant écrit
 * vraiment, en français, en arabe, et dans le jargon des logiciels de caisse
 * (PV, PA, PCB, gencod). La colonne d'un nom arabe n'a souvent aucun en-tête
 * reconnaissable : elle se reconnaît alors à son contenu.
 *
 * Aucune proposition n'est un verdict : chaque champ se redésigne à l'écran,
 * et un champ peut rester sans colonne — seul le nom est obligatoire
 * (SPEC § 2.6).
 */

export type Field =
  | 'name_fr'
  | 'name_ar'
  | 'code'
  | 'barcode'
  | 'category'
  | 'brand'
  | 'unit_label'
  | 'pieces_per_carton'
  | 'unit_price'
  | 'cost_price'

export interface FieldSpec {
  field: Field
  label: string
  /** Ce que le champ devient en base, dit au patron. */
  hint: string
  /** Le champ exige `view_cost` : il n'est proposé qu'à qui l'a (SPEC § 3). */
  confidential?: boolean
  synonyms: readonly string[]
}

/*
 * L'ordre est celui de l'écran : le nom d'abord, parce que c'est le seul
 * champ obligatoire, puis ce qui identifie, puis ce qui décrit, puis les prix.
 */
export const FIELDS: readonly FieldSpec[] = [
  {
    field: 'name_fr',
    label: 'Nom du produit',
    hint: 'Obligatoire',
    synonyms: [
      'nom', 'nom produit', 'nom du produit', 'designation', 'designation produit',
      'libelle', 'libelle produit', 'produit', 'article', 'description', 'name',
      'product', 'item', 'intitule',
    ],
  },
  {
    field: 'name_ar',
    label: 'Nom en arabe',
    hint: 'Affiché en arabe, cherché comme le nom français',
    synonyms: [
      'nom arabe', 'nom en arabe', 'designation arabe', 'libelle arabe', 'arabe',
      'arabic', 'name ar', 'الاسم', 'اسم', 'اسم المنتج', 'التسمية', 'المنتج',
    ],
  },
  {
    field: 'code',
    label: 'Référence',
    hint: 'La clé du réimport : une ligne déjà importée est mise à jour',
    synonyms: [
      'reference', 'ref', 'ref article', 'reference article', 'code', 'code article',
      'code produit', 'sku', 'article no', 'no article', 'id', 'المرجع', 'الرمز', 'كود',
    ],
  },
  {
    field: 'barcode',
    label: 'Code-barres',
    hint: 'EAN du fabricant',
    synonyms: [
      'code barre', 'code barres', 'codebarre', 'code a barres', 'ean', 'ean13',
      'gencod', 'gencode', 'upc', 'barcode', 'باركود', 'الباركود', 'رمز شريطي',
    ],
  },
  {
    field: 'category',
    label: 'Catégorie',
    hint: 'Créée si elle n’existe pas encore',
    synonyms: [
      'categorie', 'category', 'famille', 'sous famille', 'rayon', 'groupe',
      'classification', 'الفئة', 'الصنف', 'التصنيف',
    ],
  },
  {
    field: 'brand',
    label: 'Marque',
    hint: '',
    synonyms: ['marque', 'brand', 'fabricant', 'fournisseur marque', 'العلامة', 'الماركة'],
  },
  {
    field: 'unit_label',
    label: 'Unité',
    hint: 'Pièce, flacon, carton…',
    synonyms: ['unite', 'unite de vente', 'uv', 'unit', 'conditionnement', 'الوحدة'],
  },
  {
    field: 'pieces_per_carton',
    label: 'Pièces par carton',
    hint: 'Sert à la réception et à l’inventaire, jamais à la vente',
    synonyms: [
      'pieces par carton', 'piece par carton', 'colisage', 'pcb', 'par carton',
      'qte carton', 'quantite carton', 'carton', 'nombre par carton', 'الكمية في الكرطونة',
    ],
  },
  {
    field: 'unit_price',
    label: 'Prix de vente',
    hint: 'Le prix à l’unité de la grille',
    synonyms: [
      'prix', 'prix vente', 'prix de vente', 'prix unitaire', 'pv', 'pvht', 'pv ht',
      'prix public', 'tarif', 'price', 'الثمن', 'ثمن البيع', 'السعر', 'سعر البيع',
    ],
  },
  {
    field: 'cost_price',
    label: 'Prix d’achat',
    hint: 'Visible du patron seul',
    confidential: true,
    synonyms: [
      'prix achat', 'prix d achat', 'pa', 'pa ht', 'cout', 'cout achat', 'cout revient',
      'prix revient', 'achat', 'cost', 'ثمن الشراء', 'سعر الشراء', 'التكلفة',
    ],
  },
]

export const FIELD_LABELS = Object.fromEntries(
  FIELDS.map((spec) => [spec.field, spec.label]),
) as Readonly<Record<Field, string>>

/** Une colonne du fichier par champ ; un champ sans colonne n'est pas importé. */
export type Mapping = Partial<Record<Field, number>>

/**
 * La forme sous laquelle deux en-têtes se comparent : minuscules, sans
 * accents, sans ponctuation, blancs ramenés à un seul. Le pendant côté
 * appareil de `merx.search_fold()`, en plus simple — il n'y a pas de faute de
 * frappe à rattraper dans un en-tête, seulement de la ponctuation.
 */
export function foldHeader(raw: string): string {
  return raw
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

/** La part de caractères arabes d'un texte — ce qui reconnaît une colonne arabe. */
function arabicShare(values: readonly string[]): number {
  let arabic = 0
  let letters = 0
  for (const value of values) {
    for (const char of value) {
      if (!/\p{L}/u.test(char)) continue
      letters += 1
      if (/\p{Script=Arabic}/u.test(char)) arabic += 1
    }
  }
  return letters === 0 ? 0 : arabic / letters
}

/*
 * Le score d'une colonne pour un champ : un en-tête égal à un synonyme vaut
 * mieux qu'un en-tête qui le contient, et un synonyme long vaut mieux qu'un
 * court — « prix achat » doit gagner sur « prix » pour la colonne du coût,
 * sans quoi le prix d'achat se retrouve en prix de vente, ce qui vend à perte.
 */
function scoreOf(header: string, spec: FieldSpec): number {
  const folded = foldHeader(header)
  if (folded === '') return 0

  let best = 0
  for (const synonym of spec.synonyms) {
    const target = foldHeader(synonym)
    if (folded === target) best = Math.max(best, 1000 + target.length)
    else if (folded.includes(target)) best = Math.max(best, 100 + target.length)
  }
  return best
}

/**
 * La correspondance proposée. Les meilleurs couples (colonne, champ) sont pris
 * d'abord ; une colonne ne sert qu'une fois, un champ n'en reçoit qu'une.
 * `withCost` : le compte lit le prix d'achat (`view_cost`) — sinon la colonne
 * n'est pas proposée, et le champ n'est pas offert à l'écran.
 */
export function proposeMapping(
  headers: readonly string[],
  sample: readonly (readonly string[])[] = [],
  withCost = true,
): Mapping {
  const fields = FIELDS.filter((spec) => withCost || spec.confidential !== true)
  const candidates: Array<{ field: Field; column: number; score: number }> = []

  headers.forEach((header, column) => {
    for (const spec of fields) {
      const score = scoreOf(header, spec)
      if (score > 0) candidates.push({ field: spec.field, column, score })
    }
  })
  candidates.sort((a, b) => b.score - a.score)

  const mapping: Mapping = {}
  const usedColumns = new Set<number>()
  for (const candidate of candidates) {
    if (mapping[candidate.field] !== undefined || usedColumns.has(candidate.column)) continue
    mapping[candidate.field] = candidate.column
    usedColumns.add(candidate.column)
  }

  /*
   * Le nom arabe n'a souvent aucun en-tête : « العربية », ou rien du tout. Une
   * colonne restée libre dont le contenu est massivement arabe est celle-là.
   */
  if (mapping.name_ar === undefined) {
    headers.forEach((_header, column) => {
      if (mapping.name_ar !== undefined || usedColumns.has(column)) return
      const values = sample.map((row) => row[column] ?? '').filter((value) => value !== '')
      if (values.length > 0 && arabicShare(values) > 0.5) {
        mapping.name_ar = column
        usedColumns.add(column)
      }
    })
  }

  return mapping
}
