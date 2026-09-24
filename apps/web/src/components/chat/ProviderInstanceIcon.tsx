import { type CSSProperties, memo } from "react";
import { isProviderDriverKind, type ProviderDriverKind } from "@t3tools/contracts";
import {
  normalizeProviderAccentColor,
  providerInstanceInitials,
} from "@t3tools/client-runtime/state/provider-instance-display";

import type { Icon } from "../Icons";
import { PROVIDER_ICON_BY_PROVIDER } from "./providerIconUtils";
import { cn } from "~/lib/utils";

export { providerInstanceInitials };

/**
 * Title presentation for the provider instance editor
 * (`ProviderInstanceCard`): the
 * display-name fallback order (explicit name, then driver label, then the
 * raw driver slug), the normalized accent color, and the narrowed driver
 * kind for the icon. Pure so the fallback order stays pinned by unit test.
 */
export function resolveProviderInstanceTitle(input: {
  readonly displayName?: string | undefined;
  readonly driverLabel?: string | undefined;
  readonly driver: string;
  readonly accentColor?: string | undefined;
}): {
  readonly displayName: string;
  readonly accentColor: string | undefined;
  readonly driverKind: ProviderDriverKind | null;
} {
  return {
    displayName: input.displayName?.trim() || input.driverLabel || String(input.driver),
    accentColor: normalizeProviderAccentColor(input.accentColor),
    driverKind: isProviderDriverKind(input.driver) ? input.driver : null,
  };
}

/**
 * Header glyph for one provider instance title: the brand icon with its
 * accent badge when the driver narrows to a driver kind, else the driver's
 * fallback glyph, else the display-name initials.
 */
export function ProviderInstanceTitleIcon(props: {
  readonly displayName: string;
  readonly accentColor?: string | undefined;
  readonly driverKind: ProviderDriverKind | null;
  readonly fallbackIcon?: Icon | undefined;
}) {
  if (props.driverKind) {
    return (
      <ProviderInstanceIcon
        driverKind={props.driverKind}
        displayName={props.displayName}
        accentColor={props.accentColor}
        showBadge={Boolean(props.accentColor)}
        className="size-5"
        iconClassName="size-4 text-foreground/80"
        badgeClassName="right-[-0.125rem] bottom-[-0.125rem] h-3 min-w-3 px-0.5 text-[7px]"
      />
    );
  }
  const FallbackIconComponent = props.fallbackIcon;
  if (FallbackIconComponent) {
    return (
      <span className="inline-flex size-5 shrink-0 items-center justify-center">
        <FallbackIconComponent className="size-4 text-foreground/80" aria-hidden />
      </span>
    );
  }
  return (
    <span
      className="inline-flex size-5 shrink-0 items-center justify-center text-[10px] font-semibold leading-none text-foreground/80"
      aria-hidden
    >
      {providerInstanceInitials(props.displayName)}
    </span>
  );
}

export const ProviderInstanceIcon = memo(function ProviderInstanceIcon(props: {
  driverKind: ProviderDriverKind;
  displayName: string;
  accentColor?: string | undefined;
  showBadge?: boolean;
  badgeContent?: "initials" | "none";
  className?: string;
  iconClassName?: string;
  badgeClassName?: string;
  statusDotClassName?: string;
  indicatorBackground?: string;
}) {
  const Icon = PROVIDER_ICON_BY_PROVIDER[props.driverKind] ?? null;
  const indicatorBackground = props.indicatorBackground ?? "var(--card)";
  const accentStyle = props.accentColor
    ? ({ "--provider-accent": props.accentColor } as CSSProperties)
    : undefined;
  const badgeContent = props.badgeContent ?? "initials";

  return (
    <span
      className={cn(
        "relative isolate inline-flex shrink-0 items-center justify-center overflow-visible",
        props.className,
      )}
      style={accentStyle}
      data-provider-accent-color={props.accentColor}
    >
      {Icon ? (
        <Icon className={cn("size-5 shrink-0", props.iconClassName)} aria-hidden />
      ) : (
        <span className={cn("text-[10px] font-semibold leading-none", props.iconClassName)}>
          {providerInstanceInitials(props.displayName)}
        </span>
      )}
      {props.statusDotClassName ? (
        <span
          className={cn(
            "pointer-events-none absolute -left-0.5 -top-0.5 z-10 size-2 rounded-full",
            props.statusDotClassName,
          )}
          style={{ boxShadow: `0 0 0 2px ${indicatorBackground}` }}
          aria-hidden
        />
      ) : null}
      {props.showBadge ? (
        <span
          className={cn(
            "pointer-events-none absolute right-0 bottom-0 z-10 flex h-3.5 min-w-3.5 items-center justify-center rounded-full border px-0.5 text-[8px] font-semibold leading-none shadow-sm",
            props.accentColor
              ? "bg-[var(--provider-accent)] text-white"
              : "bg-card text-muted-foreground",
            props.badgeClassName,
          )}
          style={{ borderColor: indicatorBackground }}
          aria-hidden
        >
          {badgeContent === "initials" ? providerInstanceInitials(props.displayName) : null}
        </span>
      ) : null}
    </span>
  );
});
