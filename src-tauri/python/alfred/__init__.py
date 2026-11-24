"""SDK Python d’Alfred : ``import alfred``.

Le code Python d’un module (fonction en ``runtime: "python"``, noyau du module) parle au cœur d’Alfred par ce
paquet, avec les mêmes accès que le code de ce module, ni plus ni moins : sa base, ses fichiers, ses comptes, ses
canaux. Alfred lance le processus avec trois variables :

- ``ALFRED_SDK_URL`` : l’adresse locale du pont (``http://127.0.0.1:<port>/sdk``) ;
- ``ALFRED_SDK_TOKEN`` : le jeton de ce processus, propre à ce module, qui cesse de valoir à la fin du processus ;
- ``ALFRED_MODULE`` : l’identifiant du module.

Le paquet n’utilise que la bibliothèque standard. Chaque appel est synchrone et lève :class:`AlfredError` en cas
d’échec, avec le message d’Alfred en français.

Exemple ::

    import alfred

    jira = alfred.client("jira")
    reponse = jira.get("/rest/api/3/myself")
    alfred.db.execute("INSERT INTO jira_moi (nom) VALUES (?)", [reponse.body["displayName"]])
"""

from __future__ import annotations

import base64
import json
import os
import sys
import urllib.error
import urllib.request
from typing import Any, Dict, List, Mapping, Optional, Sequence, Union

__all__ = [
    "AlfredError",
    "Response",
    "Channel",
    "Client",
    "call",
    "client",
    "db",
    "files",
    "secrets",
    "events",
    "channels",
    "functions",
    "jobs",
    "notify",
    "log",
    "module",
    "examples",
    "SECRET_REF_PREFIX",
]

__version__ = "1.0.0"

#: Valeur SQL acceptée par :mod:`alfred.db`.
SqlValue = Union[str, int, float, bool, None]

#: Préfixe des références de secret (``alfred-secret-ref:v1:<nonce>``).
SECRET_REF_PREFIX = "alfred-secret-ref:v1:"

#: Identifiant du module qui exécute ce code (``ALFRED_MODULE``).
module: str = os.environ.get("ALFRED_MODULE", "")

#: Vrai quand l’appel montre des données d’exemple : aucune requête ne part alors vers un service.
examples: bool = os.environ.get("ALFRED_EXAMPLES") == "1"

# Délai d’un appel au pont, en secondes : une requête vers un service peut être longue.
_TIMEOUT = 150.0


class AlfredError(Exception):
    """Échec d’un appel à Alfred : accès refusé, requête invalide, pont absent ou jeton expiré.

    Attributs :
        message : le message d’Alfred, en français ;
        status : le code HTTP du pont (401 jeton absent ou expiré, 403 refus, 400 erreur), ou ``None`` ;
        method : la méthode appelée (``db.query``…) ;
        detail : précisions éventuelles d’Alfred (dictionnaire), ou ``None``.
    """

    def __init__(
        self,
        message: str,
        *,
        status: Optional[int] = None,
        method: Optional[str] = None,
        detail: Any = None,
    ) -> None:
        super().__init__(message)
        self.message = message
        self.status = status
        self.method = method
        self.detail = detail

    def __str__(self) -> str:
        return self.message if not self.method else f"{self.message} (alfred.{self.method})"


def _redact(text: str) -> str:
    """Retire le jeton du pont d’un texte (message de journal, erreur)."""
    token = os.environ.get("ALFRED_SDK_TOKEN", "")
    return text.replace(token, "[jeton]") if token else text


def call(name: str, /, **params: Any) -> Any:
    """Appelle la méthode ``name`` du pont (``db.query``, ``clients.request``…) et rend son résultat.

    Les fonctions de ce paquet passent toutes par ici ; ``call`` sert pour une méthode qu’elles n’enveloppent pas.
    Les paramètres ``None`` ne sont pas envoyés.
    """
    url = os.environ.get("ALFRED_SDK_URL")
    token = os.environ.get("ALFRED_SDK_TOKEN")
    if not url or not token:
        raise AlfredError(
            "Pont d’Alfred absent : ce code doit être lancé par Alfred (fonction du module ou noyau Python), "
            "qui fournit ALFRED_SDK_URL et ALFRED_SDK_TOKEN.",
            method=name,
        )
    body = json.dumps({key: value for key, value in params.items() if value is not None}).encode("utf-8")
    request = urllib.request.Request(
        f"{url.rstrip('/')}/{name}",
        data=body,
        method="POST",
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "X-Alfred-Module": module,
        },
    )
    # Le pont est local : aucun proxy du poste ne doit s’intercaler.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(request, timeout=_TIMEOUT) as response:
            payload = json.loads(response.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError as error:
        try:
            payload = json.loads(error.read().decode("utf-8") or "{}")
        except ValueError:
            payload = {}
        failure = payload.get("error") if isinstance(payload, dict) else None
        message = (failure or {}).get("message") if isinstance(failure, dict) else None
        raise AlfredError(
            _redact(message or f"Le pont d’Alfred a répondu {error.code}."),
            status=error.code,
            method=name,
            detail=(failure or {}).get("detail") if isinstance(failure, dict) else None,
        ) from None
    except (urllib.error.URLError, OSError) as error:
        raise AlfredError(
            f"Le pont d’Alfred ne répond pas ({getattr(error, 'reason', error)}) : Alfred est-il encore ouvert ?",
            method=name,
        ) from None
    if not isinstance(payload, dict) or "ok" not in payload:
        failure = payload.get("error") if isinstance(payload, dict) else None
        message = failure.get("message") if isinstance(failure, dict) else None
        raise AlfredError(_redact(message or "Réponse du pont illisible."), method=name)
    return payload["ok"]


# --- Base de l’espace ---------------------------------------------------------------------------------------------


class _Db:
    """Base de l’espace : les tables du module (préfixe ``<module>_``) et celles que ses dépendances lui ouvrent."""

    def query(self, sql: str, params: Sequence[SqlValue] = ()) -> List[Dict[str, Any]]:
        """Exécute une lecture et rend les lignes, chacune en dictionnaire colonne → valeur."""
        return call("db.query", sql=sql, params=list(params))

    def execute(self, sql: str, params: Sequence[SqlValue] = ()) -> Dict[str, int]:
        """Exécute une écriture ; rend ``{"changes": n, "lastInsertId": id}``."""
        return call("db.execute", sql=sql, params=list(params))


db = _Db()


# --- Comptes (clients déclarés) ------------------------------------------------------------------------------------


class Response:
    """Réponse d’un service appelé par :meth:`Client.request`.

    Attributs : ``status`` (code HTTP), ``ok`` (2xx), ``headers`` (dictionnaire), ``body`` (JSON décodé, sinon le
    texte), ``cached`` (resservie par le cache d’Alfred).
    """

    def __init__(self, raw: Mapping[str, Any]) -> None:
        self.status: int = int(raw.get("status", 0))
        self.ok: bool = bool(raw.get("ok", False))
        self.headers: Dict[str, str] = dict(raw.get("headers") or {})
        self.body: Any = raw.get("body")
        self.cached: bool = bool(raw.get("cached", False))
        self.raw: Dict[str, Any] = dict(raw)

    def raise_for_status(self) -> "Response":
        """Lève :class:`AlfredError` si le service a répondu par une erreur ; rend la réponse sinon."""
        if not self.ok:
            detail = self.body if isinstance(self.body, (dict, list)) else {"body": self.body}
            raise AlfredError(f"Le service a répondu {self.status}.", status=self.status, detail=detail)
        return self

    def json(self) -> Any:
        """Le corps décodé (déjà fait par Alfred quand la réponse est du JSON)."""
        if isinstance(self.body, str):
            return json.loads(self.body)
        return self.body

    def __repr__(self) -> str:
        return f"<alfred.Response {self.status}>"


class Client:
    """Compte d’un service déclaré par le module (``uses.clients`` de ``module.json``).

    Alfred exécute la requête et y ajoute l’authentification : le code ne voit jamais le secret et ne joint que
    l’adresse de base du compte. Sans ``instance``, c’est le compte par défaut (ou celui de la page appelante).
    """

    def __init__(self, id: str, instance: Optional[str] = None) -> None:
        self.id = id
        self.instance = instance

    def request(
        self,
        method: str = "GET",
        path: str = "/",
        *,
        query: Optional[Mapping[str, Any]] = None,
        headers: Optional[Mapping[str, str]] = None,
        body: Any = None,
        form: Optional[Mapping[str, Any]] = None,
        multipart: Optional[Sequence[Mapping[str, Any]]] = None,
        file: Optional[str] = None,
        response_type: Optional[str] = None,
        cache: Optional[int] = None,
        sealed: Optional[bool] = None,
    ) -> Response:
        """Envoie une requête au compte. ``body`` : objet envoyé en JSON, ou texte tel quel ; ``response_type`` :
        ``"auto"``, ``"text"`` ou ``"base64"`` ; ``cache`` : secondes de cache d’une lecture."""
        raw = call(
            "clients.request",
            client=self.id,
            instance=self.instance,
            method=method.upper(),
            path=path,
            query=dict(query) if query is not None else None,
            headers=dict(headers) if headers is not None else None,
            body=body,
            form=dict(form) if form is not None else None,
            multipart=[dict(part) for part in multipart] if multipart is not None else None,
            file=file,
            responseType=response_type,
            cache=cache,
            sealed=sealed,
        )
        return Response(raw)

    def get(self, path: str, query: Optional[Mapping[str, Any]] = None, *, cache: Optional[int] = None) -> Response:
        """Lecture ``GET``."""
        return self.request("GET", path, query=query, cache=cache)

    def post(self, path: str, body: Any = None) -> Response:
        return self.request("POST", path, body=body)

    def put(self, path: str, body: Any = None) -> Response:
        return self.request("PUT", path, body=body)

    def patch(self, path: str, body: Any = None) -> Response:
        return self.request("PATCH", path, body=body)

    def delete(self, path: str) -> Response:
        return self.request("DELETE", path)

    def download(self, path: str, *, name: Optional[str] = None, **options: Any) -> Dict[str, Any]:
        """Télécharge dans les fichiers du module, sans passer par ce code ; rend ``{status, ok, headers, file}``."""
        return call("clients.download", client=self.id, instance=self.instance, path=path, name=name, **options)

    def stream(self, path: str, *, format: Optional[str] = None, **options: Any) -> Dict[str, Any]:
        """Ouvre une réponse en continu (SSE, journal) ; rend l’identifiant du canal (``channel``) que lit la page."""
        return call("clients.stream", client=self.id, instance=self.instance, path=path, format=format, **options)

    def instances(self) -> List[Dict[str, Any]]:
        """Comptes ajoutés par l’utilisateur pour ce service, le premier étant celui par défaut."""
        return call("clients.instances", client=self.id)

    def params(self) -> Dict[str, Any]:
        """Paramètres non secrets du compte (royaume, montage…) : ``{instance, params}``."""
        return call("clients.params", client=self.id, instance=self.instance)

    def clear_cache(self) -> Dict[str, int]:
        """Oublie les réponses gardées pour ce service (après une écriture)."""
        return call("clients.clearCache", client=self.id)

    def __repr__(self) -> str:
        return f"<alfred.Client {self.id}{'@' + self.instance if self.instance else ''}>"


def client(id: str, instance: Optional[str] = None) -> Client:
    """Le compte ``id`` du module (``alfred.client("jira")``) ; ``instance`` : un compte précis."""
    return Client(id, instance)


# --- Secrets scellés -----------------------------------------------------------------------------------------------


class _Secrets:
    """Valeurs scellées : un champ secret d’un service arrive ici sous forme de référence opaque, jamais en clair.

    Le code peut la garder, la rendre à la page ou la renvoyer dans une requête scellée (``sealed=True``). Il ne peut
    ni l’afficher ni l’écrire : c’est la page qui appelle ``secrets.reveal`` ou ``secrets.writeEnvFile``.
    """

    PREFIX = SECRET_REF_PREFIX

    def is_ref(self, value: Any) -> bool:
        """La valeur est-elle une référence de secret ?"""
        return isinstance(value, str) and value.startswith(SECRET_REF_PREFIX)

    def reveal(self, ref: str, label: Optional[str] = None) -> None:
        """Toujours refusé ici : seule une page affiche un secret, après un clic de l’utilisateur."""
        raise AlfredError("Le code Python n’affiche pas de secret : la page appelle secrets.reveal.", method="secrets.reveal")

    def write_env_file(self, *args: Any, **kwargs: Any) -> None:
        """Toujours refusé ici : seule une page fait écrire un ``.env``, à l’endroit choisi par l’utilisateur."""
        raise AlfredError(
            "Le code Python n’écrit pas de .env : la page appelle secrets.writeEnvFile.", method="secrets.writeEnvFile"
        )


secrets = _Secrets()


# --- Fichiers du module --------------------------------------------------------------------------------------------


class _Files:
    """Fichiers du module, rangés par Alfred hors de l’espace versionné ; 50 Mo par fichier."""

    def save(
        self,
        name: str,
        *,
        text: Optional[str] = None,
        data: Optional[bytes] = None,
        mime: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Range un contenu (``text`` ou ``data`` en octets) ; rend sa fiche ``{id, name, mime, size, sha256…}``."""
        if (text is None) == (data is None):
            raise AlfredError("Fournir text ou data, pas les deux.", method="files.save")
        encoded = base64.b64encode(data).decode("ascii") if data is not None else None
        return call("files.save", name=name, text=text, data=encoded, mime=mime)

    def list(self, prefix: Optional[str] = None, limit: Optional[int] = None) -> List[Dict[str, Any]]:
        """Fichiers du module, du plus récent au plus ancien ; ``prefix`` filtre sur le nom."""
        return call("files.list", prefix=prefix, limit=limit)

    def get(self, id: str) -> Dict[str, Any]:
        """Fiche d’un fichier."""
        return call("files.get", id=id)

    def read(self, id: str) -> bytes:
        """Contenu d’un fichier, en octets."""
        return base64.b64decode(call("files.read", id=id)["data"])

    def read_text(self, id: str) -> str:
        """Contenu d’un fichier, en texte UTF-8."""
        return call("files.readText", id=id)

    def remove(self, id: str) -> None:
        call("files.remove", id=id)


files = _Files()


# --- Événements, fonctions, tâches ---------------------------------------------------------------------------------


class _Events:
    """Événements du module (``events`` de ``module.json``)."""

    def publish(self, event: str, payload: Any = None, occurrence: Optional[str] = None) -> Dict[str, Any]:
        """Publie ``event`` ; ``occurrence`` évite un doublon. Rend ``{event, subscribers, duplicate?}``."""
        return call("events.publish", event=event, payload=payload, occurrence=occurrence)


events = _Events()


class _Functions:
    """Fonctions de l’espace, appelées avec les accès de ce module."""

    def call(self, function: str, input: Any = None) -> Any:
        """Appelle ``function`` (``"compter"`` pour une fonction du module, ``"autre/compter"`` sinon)."""
        return call("functions.call", function=function, input=input if input is not None else {})


functions = _Functions()


class _Jobs:
    """Tâches de fond du module."""

    def start(self, function: str, input: Any = None, title: Optional[str] = None) -> Dict[str, Any]:
        return call("jobs.start", function=function, input=input, title=title)

    def get(self, id: str) -> Dict[str, Any]:
        return call("jobs.get", id=id)

    def list(self, status: Optional[str] = None, limit: Optional[int] = None) -> List[Dict[str, Any]]:
        return call("jobs.list", status=status, limit=limit)

    def cancel(self, id: str) -> Any:
        return call("jobs.cancel", id=id)


jobs = _Jobs()


# --- Canaux de progression -----------------------------------------------------------------------------------------


class Channel:
    """Canal ouvert par :func:`alfred.channels.open` : ce code y publie, la page le lit avec ``useChannel(id)``."""

    def __init__(self, id: str) -> None:
        self.id = id

    def publish(self, message: Any) -> bool:
        """Publie un message : texte tel quel, ou valeur JSON (dictionnaire, liste, nombre). Rend ``False`` si plus
        personne ne lit (page fermée) ; le travail peut continuer."""
        if isinstance(message, str):
            return bool(call("channels.publish", channel=self.id, text=message)["open"])
        return bool(call("channels.publish", channel=self.id, data=message)["open"])

    def close(self) -> None:
        """Ferme le canal : la page lit la fin (``closed``)."""
        call("channels.close", channel=self.id)

    def __enter__(self) -> "Channel":
        return self

    def __exit__(self, *exc: Any) -> None:
        try:
            self.close()
        except AlfredError:
            pass

    def __repr__(self) -> str:
        return f"<alfred.Channel {self.id}>"


class _Channels:
    """Canaux : un flux de messages vers la page du module (progression d’un import, journal d’un calcul)."""

    def open(self, name: Optional[str] = None) -> Channel:
        """Ouvre un canal. Avec ``name``, son identifiant est connu d’avance : ``"<module>:<name>"``, que la page
        peut lire avant même son ouverture ; le rouvrir reprend là où il s’était arrêté."""
        return Channel(call("channels.open", name=name)["channel"])

    def read(self, channel: str, after: int = 0, wait: int = 0) -> Dict[str, Any]:
        """Lit un canal du module (flux d’un service) : ``{events, next, closed…}``."""
        return call("channels.read", channel=channel, after=after, wait=wait)

    def write(self, channel: str, text: str) -> None:
        """Écrit dans un WebSocket ouvert par ``client(id).socket``."""
        call("channels.write", channel=channel, text=text)

    def close(self, channel: str) -> None:
        call("channels.close", channel=channel)


channels = _Channels()


# --- Notifications et journal --------------------------------------------------------------------------------------


def notify(title: str, description: Optional[str] = None, tone: str = "info") -> None:
    """Affiche une notification dans Alfred (et au système quand Alfred est en arrière-plan).

    ``tone`` : ``"info"``, ``"success"``, ``"warning"`` ou ``"error"``.
    """
    call("notify", title=title, description=description, tone=tone)


class _Log:
    """Journal d’exécution de l’espace (Réglages › Journal). ``alfred.log("texte")`` écrit au niveau ``info``.

    Le message part aussi sur stderr. Le jeton du pont n’y apparaît jamais ; n’y mettez pas de secret.
    """

    def __call__(self, message: str, **data: Any) -> None:
        self._write("info", message, data)

    def info(self, message: str, **data: Any) -> None:
        self._write("info", message, data)

    def warning(self, message: str, **data: Any) -> None:
        self._write("warning", message, data)

    def error(self, message: str, **data: Any) -> None:
        self._write("error", message, data)

    def _write(self, level: str, message: str, data: Mapping[str, Any]) -> None:
        text = _redact(str(message))
        print(f"[alfred:{level}] {text}", file=sys.stderr, flush=True)
        extra = json.loads(_redact(json.dumps(dict(data), default=str))) if data else None
        call("log", level=level, message=text, data=extra)


log = _Log()
