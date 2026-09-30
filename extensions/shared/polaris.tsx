/// <reference types="@shopify/ui-extensions/admin.order-details.block.render" />
/// <reference types="@shopify/ui-extensions/admin.order-details.action.render" />
/** @jsxImportSource preact */
import type {} from '@shopify/ui-extensions/admin';
import {cloneElement, type ComponentChildren, type ComponentProps, type VNode} from 'preact';

// Keep the composer's value callbacks and layout intent stable while rendering
// only Polaris web components. No legacy React extension runtime is used.
type Children = {children?: ComponentChildren};
type Props<T extends keyof preact.JSX.IntrinsicElements> = ComponentProps<T>;

export function AdminBlock({title, children}: Children & {title: string}) {
  return <s-admin-block heading={title}>{children}</s-admin-block>;
}

export function AdminAction({title, loading, primaryAction, secondaryAction, children}: Children & {
  title?: string; loading?: boolean; primaryAction?: VNode; secondaryAction?: VNode;
}) {
  return <s-admin-action heading={title} loading={loading}>
    {children}
    {primaryAction && cloneElement(primaryAction, {slot: 'primary-action'})}
    {secondaryAction && cloneElement(secondaryAction, {slot: 'secondary-actions'})}
  </s-admin-action>;
}

export function BlockStack({children, ...props}: Props<'s-stack'>) {
  return <s-stack {...props} direction="block">{children}</s-stack>;
}

export function InlineStack({children, inlineAlignment, blockAlignment, ...props}: Props<'s-stack'> & {
  inlineAlignment?: Props<'s-stack'>['justifyContent']; blockAlignment?: Props<'s-stack'>['alignItems'];
}) {
  return <s-stack {...props} direction="inline" justifyContent={inlineAlignment} alignItems={blockAlignment}>{children}</s-stack>;
}

type Dimensions = 'inlineSize' | 'minInlineSize' | 'maxInlineSize' | 'blockSize' | 'minBlockSize' | 'maxBlockSize';
type BoxProps = Omit<Props<'s-box'>, Dimensions> & {[K in Dimensions]?: Props<'s-box'>[K] | number};
export function Box({children, ...props}: BoxProps) {
  const dimensions: Dimensions[] = ['inlineSize', 'minInlineSize', 'maxInlineSize', 'blockSize', 'minBlockSize', 'maxBlockSize'];
  const converted = {...props};
  for (const key of dimensions) {
    if (typeof converted[key] === 'number') converted[key] = `${converted[key]}px`;
  }
  return <s-box {...converted as Props<'s-box'>}>{children}</s-box>;
}

export function Button({children, onPress, ...props}: Props<'s-button'> & {onPress?: () => void}) {
  return <s-button {...props} onClick={onPress}>{children}</s-button>;
}

export function Pressable({children, onPress, ...props}: Props<'s-clickable'> & {onPress?: () => void}) {
  return <s-clickable {...props} disabled={props.disabled || !onPress} onClick={onPress}>{children}</s-clickable>;
}

export function Text({children, fontWeight, ...props}: Props<'s-text'> & {fontWeight?: 'bold'}) {
  return <s-text {...props}>{fontWeight === 'bold' ? <s-text type="strong">{children}</s-text> : children}</s-text>;
}

export function TextField({onChange, accessibilityLabel, ...props}: Omit<Props<'s-text-field'>, 'onChange'> & {accessibilityLabel?: string; onChange?: (value: string) => void}) {
  // Input commits immediately, so Send always reads the latest typed value.
  return <s-text-field {...props} label={props.label || accessibilityLabel} labelAccessibilityVisibility={!props.label && accessibilityLabel ? "exclusive" : props.labelAccessibilityVisibility} onInput={(event) => onChange?.(event.currentTarget.value)} />;
}

export function Select({options, onChange, ...props}: Omit<Props<'s-select'>, 'onChange'> & {
  options: {label: string; value: string}[]; onChange: (value: string) => void;
}) {
  return <s-select {...props} onChange={(event) => onChange(event.currentTarget.value)}>
    {options.map(({label, value}) => <s-option key={value} value={value}>{label}</s-option>)}
  </s-select>;
}

type DateSelection = string | {start?: string; end?: string};
export function DatePicker({selected, onChange}: {selected?: DateSelection; onChange: (value: DateSelection) => void}) {
  const range = typeof selected === 'object';
  const value = range ? `${selected.start || ''}--${selected.end || ''}` : selected || '';
  return <s-date-picker type={range ? 'range' : 'single'} value={value} onChange={(event) => {
    const next = event.currentTarget.value;
    if (range) {
      const [start, end] = next.split('--');
      onChange({start: start || '', end: end || ''});
    } else {
      onChange(next);
    }
  }} />;
}

export function Badge({children, ...props}: Props<'s-badge'>) {
  return <s-badge {...props}>{children}</s-badge>;
}
export function Banner({children, ...props}: Props<'s-banner'>) {
  return <s-banner {...props}>{children}</s-banner>;
}
export function Divider() { return <s-divider />; }
export function ProgressIndicator(props: Props<'s-spinner'>) { return <s-spinner {...props} />; }
export function Image({source, accessibilityLabel, ...props}: Props<'s-image'> & {source: string; accessibilityLabel?: string}) {
  return <s-image {...props} src={source} alt={accessibilityLabel || props.alt} />;
}
