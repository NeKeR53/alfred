"""Noyau Python d'un module d'Alfred : un processus long qui garde les objets créés par les pages.

Embarqué dans Alfred (`kernel.rs`), jamais copié dans le module. Lancé avec `python -X utf8 -c <ce code> <dossier>`,
où `<dossier>` est le dossier `python/` du module : ses fichiers s'importent par leur nom (`analyse.py` → `analyse`).

Protocole : une ligne JSON par message.
- Alfred → noyau (stdin) : `{"id": 1, "op": "create" | "call" | "run" | "main" | "dispose" | "ping", ...}`.
- Noyau → Alfred (stdout) : `{"ready": true, "python": "3.12.1", "pid": 123}` au démarrage, puis pour chaque
  requête `{"id": 1, "ok": true, "result": ...}` ou `{"id": 1, "ok": false, "error": {"type", "message", "trace"}}`,
  et, pendant un appel, `{"id": 1, "event": "progress" | "data", "data": ...}`.

La vraie sortie standard est gardée pour le protocole : `print` et tout ce que les bibliothèques écrivent partent
sur stderr, qu'Alfred note au journal du module. L'entrée standard est fermée au code du module.
Les requêtes sont traitées une à la fois, dans l'ordre d'arrivée.
"""

import dataclasses
import datetime
import decimal
import importlib
import importlib.util
import inspect
import json
import os
import pathlib
import platform
import sys
import traceback
import types
import uuid

# Le protocole garde pour lui la vraie sortie et la vraie entrée standard.
_protocol_out = os.fdopen(os.dup(1), "w", encoding="utf-8", newline="\n")
_protocol_in = os.fdopen(os.dup(0), "r", encoding="utf-8")
os.dup2(2, 1)
sys.stdout = sys.stderr
_null = os.open(os.devnull, os.O_RDONLY)
os.dup2(_null, 0)
os.close(_null)
sys.stdin = open(os.devnull, "r", encoding="utf-8")

PYTHON_DIR = os.path.realpath(sys.argv[1]) if len(sys.argv) > 1 else os.path.realpath("python")
sys.path.insert(0, PYTHON_DIR)

_objects = {}
_current = None


def _send(message):
    _protocol_out.write(json.dumps(message, ensure_ascii=False, allow_nan=False) + "\n")
    _protocol_out.flush()


class KernelError(Exception):
    """Erreur d'usage du noyau (nom inconnu, objet introuvable) : sans trace Python."""


def _jsonable(value):
    """Valeur prête pour JSON : dataclasses, ensembles, dates, chemins, tableaux numpy (`tolist`)…"""
    if dataclasses.is_dataclass(value) and not isinstance(value, type):
        return dataclasses.asdict(value)
    if isinstance(value, (set, frozenset)):
        return list(value)
    if isinstance(value, (datetime.datetime, datetime.date, datetime.time)):
        return value.isoformat()
    if isinstance(value, (pathlib.PurePath, uuid.UUID, decimal.Decimal)):
        return str(value)
    if isinstance(value, (bytes, bytearray)):
        return value.decode("utf-8", errors="replace")
    if isinstance(value, types.GeneratorType):
        return list(value)
    for method in ("to_json", "tolist", "to_dict"):
        convert = getattr(value, method, None)
        if callable(convert):
            return convert()
    raise TypeError(f"valeur de type {type(value).__name__} non convertible en JSON")


def _encode(value):
    try:
        return json.loads(json.dumps(value, default=_jsonable, ensure_ascii=False, allow_nan=False))
    except ValueError as error:
        raise KernelError(f"Résultat non convertible en JSON (NaN ou infini ?) : {error}") from None
    except TypeError as error:
        raise KernelError(f"Résultat non convertible en JSON : {error}") from None


def _inside(path):
    if not path:
        return False
    real = os.path.realpath(path)
    return real == PYTHON_DIR or real.startswith(PYTHON_DIR + os.sep)


def _public(name):
    if not name or name.startswith("_"):
        raise KernelError(f"« {name} » est privé (nom qui commence par _) : seuls les noms publics s'appellent.")


def _resolve(target):
    """`fichier.Nom` (ou `paquet.fichier.Nom`) : un nom défini dans un fichier du dossier `python/` du module."""
    if not isinstance(target, str) or "." not in target:
        raise KernelError(f"Nom attendu sous la forme « fichier.Nom » (par exemple « analyse.Graphe ») : « {target} ».")
    module_name, name = target.rsplit(".", 1)
    _public(name)
    try:
        module = importlib.import_module(module_name)
    except ModuleNotFoundError as error:
        if error.name and module_name.split(".")[0] == error.name.split(".")[0]:
            raise KernelError(f"Fichier python/{module_name.replace('.', '/')}.py introuvable dans le module.") from None
        raise
    if not _inside(getattr(module, "__file__", None)):
        raise KernelError(f"« {module_name} » n'est pas un fichier du dossier python/ du module.")
    value = getattr(module, name, None)
    if value is None:
        raise KernelError(f"« {name} » n'existe pas dans python/{module_name.replace('.', '/')}.py.")
    if getattr(value, "__module__", None) != module.__name__:
        raise KernelError(f"« {target} » est importé d'ailleurs : seuls les noms définis dans le fichier s'appellent.")
    return value


def _invoke(function, args):
    """Objet JSON → arguments nommés ; liste → arguments positionnels ; rien → aucun ; autre → un argument."""
    if args is None:
        result = function()
    elif isinstance(args, dict):
        result = function(**args)
    elif isinstance(args, list):
        result = function(*args)
    else:
        result = function(args)
    # Une méthode génératrice envoie chaque valeur produite comme un message du flux ; `return` donne le résultat.
    if inspect.isgenerator(result):
        while True:
            try:
                emit(next(result))
            except StopIteration as stop:
                return stop.value
    return result


def progress(fraction=None, message=None, **extra):
    """Annonce l'avancement de l'appel en cours : `fraction` entre 0 et 1, `message` lisible ; sans canal, ignoré."""
    data = dict(extra)
    if fraction is not None:
        data["fraction"] = max(0.0, min(1.0, float(fraction)))
    if message is not None:
        data["message"] = str(message)
    if _current is not None:
        _send({"id": _current, "event": "progress", "data": _encode(data)})


def emit(data):
    """Envoie une valeur (texte ou JSON) dans le flux de l'appel en cours ; sans canal, ignoré."""
    if _current is not None:
        _send({"id": _current, "event": "data", "data": _encode(data)})


# Module importable par le code du module : `from alfred_kernel import progress, emit`.
_helpers = types.ModuleType("alfred_kernel")
_helpers.progress = progress
_helpers.emit = emit
_helpers.__doc__ = "Avancement et flux d'un appel du noyau Python d'Alfred."
sys.modules["alfred_kernel"] = _helpers


_main_modules = {}


def _main(path, args):
    """Fonction du module en `runtime: python` avec `kernel: true` : `main(input)` de son fichier."""
    real = os.path.realpath(path)
    module = _main_modules.get(real)
    if module is None:
        name = "alfred_function_" + uuid.uuid5(uuid.NAMESPACE_URL, real).hex
        spec = importlib.util.spec_from_file_location(name, real)
        if spec is None or spec.loader is None:
            raise KernelError(f"Fichier de fonction illisible : {path}.")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        _main_modules[real] = module
    main = getattr(module, "main", None)
    if not callable(main):
        raise KernelError("Une fonction passée par le noyau définit `def main(input):` et rend sa sortie.")
    return _invoke(main, [args])


def _handle(request):
    op = request.get("op")
    if op == "ping":
        return {"objects": len(_objects)}
    if op == "create":
        factory = _resolve(request.get("class"))
        if not inspect.isclass(factory):
            raise KernelError(f"« {request.get('class')} » n'est pas une classe : utilisez run pour une fonction.")
        _objects[request["handle"]] = _invoke(factory, request.get("args"))
        return {"handle": request["handle"]}
    if op == "call":
        handle = request.get("handle")
        if handle not in _objects:
            raise KernelError(f"Objet « {handle} » inconnu du noyau.")
        method = request.get("method")
        _public(method)
        function = getattr(_objects[handle], method, None)
        if not callable(function):
            raise KernelError(f"L'objet n'a pas de méthode « {method} ».")
        return _invoke(function, request.get("args"))
    if op == "run":
        function = _resolve(request.get("function"))
        if inspect.isclass(function) or not callable(function):
            raise KernelError(f"« {request.get('function')} » n'est pas une fonction : utilisez create pour une classe.")
        return _invoke(function, request.get("args"))
    if op == "main":
        return _main(request["path"], request.get("args"))
    if op == "dispose":
        value = _objects.pop(request.get("handle"), None)
        close = getattr(value, "close", None)
        if callable(close):
            close()
        return {"disposed": value is not None}
    raise KernelError(f"Opération inconnue : {op}")


def _short_trace(error):
    """Trace sans les cadres du noyau lui-même : seulement le code du module."""
    frames = [
        frame
        for frame in traceback.extract_tb(error.__traceback__)
        if frame.filename != "<string>" and "importlib" not in frame.filename
    ]
    lines = traceback.format_list(frames[-8:])
    lines += traceback.format_exception_only(type(error), error)
    return "".join(lines).rstrip()


def _serve():
    global _current
    _send({"ready": True, "python": platform.python_version(), "pid": os.getpid()})
    for line in _protocol_in:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except ValueError:
            continue
        identifier = request.get("id")
        _current = identifier
        try:
            result = _encode(_handle(request))
            _current = None
            _send({"id": identifier, "ok": True, "result": result})
        except KernelError as error:
            _current = None
            _send({"id": identifier, "ok": False, "error": {"type": "KernelError", "message": str(error)}})
        except BaseException as error:  # noqa: BLE001 — une erreur du module ne doit jamais arrêter le noyau
            _current = None
            if isinstance(error, (KeyboardInterrupt, SystemExit)):
                _send({"id": identifier, "ok": False, "error": {"type": type(error).__name__, "message": "Le code a demandé l'arrêt du noyau."}})
                raise
            message = f"{type(error).__name__}: {error}" if str(error) else type(error).__name__
            _send({"id": identifier, "ok": False, "error": {"type": type(error).__name__, "message": message, "trace": _short_trace(error)}})
        finally:
            sys.stderr.flush()


_serve()
