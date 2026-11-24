import { Component, type ReactNode } from "react";
import { Alert } from "socle-ui";

type Props = { children: ReactNode; resetKey?: string };
type State = { failed: boolean; resetKey?: string };

/**
 * Limite d’erreur du relevé, reprise de `ErrorBoundary` de OneApp : une erreur de rendu reste dans la conversation
 * ouverte, sans emporter la page ; changer de conversation ou « Réessayer » la réaffiche.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { failed: false, resetKey: this.props.resetKey };

  static getDerivedStateFromError() {
    // Ne pas afficher le message : il peut contenir le texte de la conversation.
    return { failed: true };
  }

  static getDerivedStateFromProps(props: Props, state: State) {
    return props.resetKey !== state.resetKey ? { failed: false, resetKey: props.resetKey } : null;
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <Alert
        tone="danger"
        title="Cette vue ne peut pas être affichée."
        action={{ label: "Réessayer", onPress: () => this.setState({ failed: false }) }}
      >
        Réessayez pour afficher de nouveau son contenu.
      </Alert>
    );
  }
}
