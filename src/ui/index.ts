/**
 * Bibliothèque d’interface d’Alfred. La coquille et les pages créées dans l’espace utilisent exactement ces
 * composants ; DESIGN.md en est la référence d’usage. Une page n’importe rien d’autre pour son apparence.
 */
import "./styles.css";
import "./accents.css";
import "./settings-surface.css";

export { AnchoredPanel } from "./components/AnchoredPanel";
export { Button, type ButtonProps, type ButtonVariant, IconButton, type IconButtonProps } from "./components/Button";
export { ChoiceButton, type ChoiceButtonProps, ChoiceGroup } from "./components/ChoiceButton";
export { Combobox, MultiSelectCombobox, SearchCombobox } from "./components/Combobox";
export { ConfirmDialog, type ConfirmOptions, useConfirm } from "./components/ConfirmDialog";
export { Code, Divider, Image } from "./components/Content";
export { DataTable, type DataTableColumn } from "./components/DataTable";
export { Dialog } from "./components/Dialog";
export { Disclosure } from "./components/Disclosure";
export { DocumentViewer, type DocumentViewerProps } from "./components/DocumentViewer";
export { EmptyState } from "./components/EmptyState";
export { Avatar, Pagination, ProgressBar, pageOf } from "./components/Essentials";
export { FeedbackBanner, type FeedbackBannerTone } from "./components/FeedbackBanner";
export { Fieldset } from "./components/Fieldset";
export { FormActions } from "./components/FormActions";
export {
  CheckboxControl,
  type ControlWidth,
  FormControlGroup,
  FormField,
  RadioControl,
  SelectControl,
  type SelectControlProps,
  SwitchControl,
  TextArea,
  TextInput,
  type TextInputProps,
} from "./components/FormControls";
export { HtmlContent, type HtmlContentProps } from "./components/HtmlContent";
export { InlineEdit } from "./components/InlineEdit";
export { Link } from "./components/Link";
export { List, ListItem } from "./components/List";
export { LoadingSkeleton } from "./components/LoadingSkeleton";
export { Markdown } from "./components/Markdown";
export { Menu, MenuGroup, MenuItem, type MenuItemProps } from "./components/Menu";
export { MenuButton } from "./components/MenuButton";
export { Modal } from "./components/Modal";
export { OverflowMenu } from "./components/OverflowMenu";
export { PageToolbar, ToolbarSeparator } from "./components/PageToolbar";
export { PageTopBar, PageTopBarSlot, PanelToggleButton } from "./components/PageTopBar";
export { PanelHeader } from "./components/PanelHeader";
export {
  Form,
  Grid,
  Heading,
  KeyValueList,
  ObjectHeader,
  Page,
  Row,
  Section,
  Spinner,
  Stack,
  Surface,
  Text,
} from "./components/page";
export { RefreshButton } from "./components/RefreshButton";
export { SearchField } from "./components/SearchField";
export { SettingRow, SettingRows } from "./components/SettingRow";
export { StatusBadge } from "./components/StatusBadge";
export { StatusDot, type StatusDotTone } from "./components/StatusDot";
export { StepList } from "./components/StepList";
export { type TabItem, Tabs } from "./components/Tabs";
export { TagSearchField, type TagSearchFieldProps } from "./components/TagSearchField";
export { type Action, ActionBar, type ActionIcon, type ActionPlace } from "./templates/actions";
export { type CollectionFilter, CollectionPage, type Column } from "./templates/CollectionPage";
export { type DetailField, DetailPanel, type DetailSection } from "./templates/DetailPanel";
export {
  type ConfirmSpec,
  confirmAction,
  type FieldOption,
  type FormFieldSpec,
  type FormSpec,
  type FormValue,
  type FormValues,
  type ModalSpec,
  openForm,
  openModal,
} from "./templates/dialogs";
export { FormattedValue, type StatusMap, type StatusTone, type ValueType } from "./templates/format";
export { usePageState } from "./templates/pageState";
export { type Setting, SettingsPage, type SettingsSection } from "./templates/SettingsPage";
export { type FrameServices, FrameServicesContext } from "./templates/services";
export {
  closeSubpage,
  openSubpage,
  type PageHeaderSpec,
  type SubpageSpec,
} from "./templates/subpages";
