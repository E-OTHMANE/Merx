/*
 * E0-04 — « Écran de connexion utilisable au doigt sur téléphone ».
 *
 * Les valeurs (56 px, 8 px, la palette) sont prouvées par
 * `src/styles/tokens.test.ts`, qui compile réellement la CSS. Ici on vérifie
 * que l'écran emploie ces jetons plutôt que des valeurs écrites à la main :
 * les deux tests réunis couvrent le critère, aucun ne le couvre seul.
 */

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import { LoginScreen } from '@/app/login/LoginScreen'
import { AuthProvider } from '@/lib/auth'
import { AUTH_MESSAGES } from '@/lib/auth/messages'
import { createFakeAuthClient, fakeSession, type FakeAuthClient } from '@/test/fakeAuth'

function renderScreen(client: FakeAuthClient = createFakeAuthClient()) {
  render(
    <AuthProvider client={client}>
      <LoginScreen />
    </AuthProvider>,
  )
  return client
}

describe("l'écran de connexion", () => {
  /*
   * BRAND-UI § 8 : « Le libellé est au-dessus, jamais un simple placeholder —
   * le placeholder disparaît à la saisie et l'utilisateur ne sait plus ce qu'il
   * remplit. » `getByLabelText` échoue si le libellé n'est pas rattaché.
   */
  it.each([['Téléphone'], ['Mot de passe']])('rattache un vrai libellé au champ %s', (label) => {
    renderScreen()

    const field = screen.getByLabelText(label)
    expect(field).toBeInTheDocument()
    expect(field).not.toHaveAttribute('placeholder')
  })

  it('place le libellé avant le champ dans le document', () => {
    renderScreen()

    const label = screen.getByText('Téléphone')
    const field = screen.getByLabelText('Téléphone')

    expect(label.compareDocumentPosition(field)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
  })

  it('emploie les hauteurs tactiles de la marque', () => {
    renderScreen()

    // 56 px pour les champs et le bouton principal — BRAND-UI § 7.
    expect(screen.getByLabelText('Téléphone')).toHaveClass('h-field')
    expect(screen.getByLabelText('Mot de passe')).toHaveClass('h-field')
    expect(screen.getByRole('button', { name: 'Se connecter' })).toHaveClass('h-button')
  })

  it('ouvre le pavé numérique et laisse le gestionnaire de mots de passe agir', () => {
    renderScreen()

    /*
     * E1-01 : l'identifiant est le numéro de téléphone. `type` et `inputMode`
     * décident du clavier qui s'ouvre sur une tablette — c'est un changement de
     * clavier de moins, mille fois par an derrière un comptoir.
     */
    const phone = screen.getByLabelText('Téléphone')
    expect(phone).toHaveAttribute('type', 'tel')
    expect(phone).toHaveAttribute('inputmode', 'tel')
    // Sans cela, la première lettre est capitalisée et l'adresse de l'éditeur,
    // qui se connecte par email, est refusée.
    expect(phone).toHaveAttribute('autocapitalize', 'none')
    expect(phone).toHaveAttribute('autocomplete', 'username')
    // BRAND-UI § 6 : « les chiffres sont le sujet. »
    expect(phone).toHaveClass('tabular')

    const password = screen.getByLabelText('Mot de passe')
    expect(password).toHaveAttribute('type', 'password')
    expect(password).toHaveAttribute('autocomplete', 'current-password')
  })

  /*
   * BRAND-UI § 9 : propriétés logiques uniquement. Le contrôle est ici plutôt
   * qu'en relecture parce qu'un `ml-2` ajouté dans six mois ne se verra pas —
   * il ne cassera rien tant que l'interface reste en français.
   */
  it("n'écrit aucune direction en dur — l'arabe n'exigera pas de reprise", () => {
    renderScreen()

    const physical = /(^|\s)(ml|mr|pl|pr|left|right)-|(^|\s)text-(left|right)(\s|$)/
    for (const element of document.body.querySelectorAll('*')) {
      expect(element.className, `classe non logique sur <${element.tagName.toLowerCase()}>`).not.toMatch(
        physical,
      )
    }
  })
})

describe('la soumission', () => {
  /*
   * E1-01 : le patron tape son numéro, Supabase Auth reçoit une adresse dérivée
   * (`@/lib/phone`). C'est ce passage qui est vérifié ici — et il l'est sur une
   * saisie ponctuée, la forme dans laquelle un numéro est réellement donné.
   */
  it('dérive l’identifiant du numéro saisi, quelle qu’en soit la ponctuation', async () => {
    const client = renderScreen()

    await userEvent.type(screen.getByLabelText('Téléphone'), '06 12 34 56 78')
    await userEvent.type(screen.getByLabelText('Mot de passe'), 'motdepasse')
    await userEvent.click(screen.getByRole('button', { name: 'Se connecter' }))

    expect(client.calls.signInWithPassword).toHaveBeenCalledWith({
      email: '0612345678@merx.invalid',
      password: 'motdepasse',
    })
  })

  it("laisse passer l'adresse de l'éditeur", async () => {
    const client = renderScreen()

    await userEvent.type(screen.getByLabelText('Téléphone'), 'editeur@merx.ma')
    await userEvent.type(screen.getByLabelText('Mot de passe'), 'motdepasse')
    await userEvent.click(screen.getByRole('button', { name: 'Se connecter' }))

    expect(client.calls.signInWithPassword).toHaveBeenCalledWith({
      email: 'editeur@merx.ma',
      password: 'motdepasse',
    })
  })

  /*
   * Un numéro mal saisi n'est pas un mot de passe faux. Les confondre enverrait
   * le commerçant chercher une erreur là où il n'y en a pas — et l'appel réseau
   * partirait pour rien.
   */
  it('refuse un numéro invalide sans appeler le serveur', async () => {
    const client = renderScreen()

    await userEvent.type(screen.getByLabelText('Téléphone'), '0612')
    await userEvent.type(screen.getByLabelText('Mot de passe'), 'motdepasse')
    await userEvent.click(screen.getByRole('button', { name: 'Se connecter' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(AUTH_MESSAGES.badIdentifier)
    expect(client.calls.signInWithPassword).not.toHaveBeenCalled()
  })

  it('affiche le refus, annoncé et rattaché aux champs', async () => {
    renderScreen(
      createFakeAuthClient({
        signInResult: { error: { message: 'Invalid login credentials', status: 400 } },
      }),
    )

    await userEvent.type(screen.getByLabelText('Téléphone'), '0612345678')
    await userEvent.type(screen.getByLabelText('Mot de passe'), 'faux')
    await userEvent.click(screen.getByRole('button', { name: 'Se connecter' }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(AUTH_MESSAGES.badCredentials)
    expect(screen.getByLabelText('Téléphone')).toHaveAttribute('aria-describedby', alert.id)
  })

  it('affiche le compte sans commerce en nommant la cause', async () => {
    renderScreen(createFakeAuthClient({ signInResult: { session: fakeSession({ tenantId: null }) } }))

    await userEvent.type(screen.getByLabelText('Téléphone'), '0712345678')
    await userEvent.type(screen.getByLabelText('Mot de passe'), 'motdepasse')
    await userEvent.click(screen.getByRole('button', { name: 'Se connecter' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      "Votre compte n'est rattaché à aucun commerce. Contactez votre responsable.",
    )
  })

  it('refuse la double soumission — la limite de débit compte chaque appui', async () => {
    let release: (() => void) | undefined
    const client = createFakeAuthClient()
    client.calls.signInWithPassword.mockImplementation(
      async () =>
        await new Promise<{ error: null }>((done) => {
          release = () => done({ error: null })
        }),
    )
    renderScreen(client)

    await userEvent.type(screen.getByLabelText('Téléphone'), '0612345678')
    await userEvent.type(screen.getByLabelText('Mot de passe'), 'motdepasse')

    const submit = screen.getByRole('button', { name: 'Se connecter' })
    await userEvent.click(submit)
    await userEvent.click(submit)

    expect(client.calls.signInWithPassword).toHaveBeenCalledTimes(1)
    expect(submit).toBeDisabled()
    release?.()
  })
})
