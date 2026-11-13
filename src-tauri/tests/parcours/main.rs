//! Parcours d’intégration d’Alfred : chaque test traverse plusieurs domaines du backend par `dispatch`, comme le
//! ferait l’interface, avec un vrai dossier d’espace, de vrais dépôts git et de vrais appels HTTP locaux.
//! L’interface est simulée par `common::Ui`, qui répond aux demandes du backend par `ui.resolve`.

mod common;

mod build_app;
mod data_and_functions;
mod clients_and_vault;
mod agent_tools;
mod webhooks_and_schedules;
mod marketplaces;
mod frames;
