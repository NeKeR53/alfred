/* Repris de OneApp : components/agents/EffortSlider.tsx. */
import { type CSSProperties, useId } from "react";
import { effortLabel } from "../effort";
import "./effort-slider.css";

/**
 * Niveau de raisonnement en curseur, sur les seuls niveaux que le harnais propose pour le modèle choisi
 * (« par défaut » d’abord, puis du plus léger au plus poussé, dans l’ordre du harnais). Clavier : flèches.
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
  const id = useId();
  const levels = ["", ...efforts.filter((effort, index) => effort && efforts.indexOf(effort) === index)];
  const index = Math.max(0, levels.indexOf(value));
  if (levels.length < 2)
    return (
      <div className="effort-slider effort-slider--single">
        <span className="effort-slider__label">{label}</span>
        <span className="effort-slider__value">Par défaut du modèle</span>
      </div>
    );
  return (
    <div className="effort-slider">
      <div className="effort-slider__head">
        <label className="effort-slider__label" htmlFor={id}>
          {label}
        </label>
        <span className="effort-slider__value" aria-hidden="true">
          {effortName(levels[index])}
        </span>
      </div>
      <input
        id={id}
        type="range"
        min={0}
        max={levels.length - 1}
        step={1}
        value={index}
        disabled={disabled}
        style={{ "--fill": index / (levels.length - 1) } as CSSProperties}
        aria-valuetext={effortName(levels[index])}
        onChange={(event) => onChange(levels[Number(event.target.value)] ?? "")}
      />
      {/* Les deux bouts seulement : le niveau choisi est écrit au-dessus, et six libellés se chevauchaient. */}
      <div className="effort-slider__ticks" aria-hidden="true">
        {levels.map((level, position) =>
          position !== 0 && position !== levels.length - 1 ? null : (
            <span
              key={level || "default"}
              className={level === levels[index] ? "is-current" : undefined}
              style={{ "--position": position / (levels.length - 1) } as CSSProperties}
            >
              {level ? effortName(level) : "défaut"}
            </span>
          ),
        )}
      </div>
    </div>
  );
}

/** Libellé d’un niveau sous le curseur, en minuscules comme dans OneApp (« élevé », « très élevé »). */
function effortName(effort: string): string {
  return effort ? effortLabel(effort).toLocaleLowerCase("fr") : "par défaut";
}
