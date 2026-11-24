import { useEffect, useState } from "react";
import { Slider } from "socle-ui";
import { effortLabel } from "../effort";

/**
 * Niveau de raisonnement en `Slider` à crans (D-380), sur les seuls niveaux que le harnais propose pour le modèle
 * choisi : « Par défaut » d’abord, puis du plus léger au plus poussé, dans l’ordre du harnais. La valeur s’écrit en
 * mots à droite ; le choix s’enregistre au relâché. Rien quand le modèle n’a qu’un niveau.
 */
export function EffortSlider({
  efforts,
  value,
  onChange,
  disabled,
  label = "Raisonnement",
}: {
  /** Niveaux proposés par le harnais ; la chaîne vide est le réglage par défaut du modèle. */
  efforts: readonly string[];
  value: string;
  onChange: (effort: string) => void;
  disabled?: boolean;
  label?: string;
}) {
  const levels = ["", ...efforts.filter((effort, index) => effort && efforts.indexOf(effort) === index)];
  const index = Math.max(0, levels.indexOf(value));
  // La poignée suit le geste ; le niveau ne part qu’au relâché (ou à chaque touche).
  const [position, setPosition] = useState(index);
  useEffect(() => setPosition(index), [index]);
  if (levels.length < 2) return null;
  return (
    <Slider
      label={label}
      width="full"
      minValue={0}
      maxValue={levels.length - 1}
      step={1}
      showSteps
      value={position}
      isDisabled={disabled}
      formatValue={(at) => effortName(levels[at] ?? "")}
      onChange={(at) => setPosition(at as number)}
      onChangeEnd={(at) => onChange(levels[at as number] ?? "")}
    />
  );
}

/** Libellé d’un niveau : « Par défaut », « Élevé », « Très élevé ». */
function effortName(effort: string): string {
  return effort ? effortLabel(effort) : "Par défaut";
}
