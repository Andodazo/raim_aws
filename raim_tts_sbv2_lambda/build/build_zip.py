# 自作の声の TTS Lambda の zip（x86_64）と、S3 に置くモデル一式（raim_models.tar）を作る。
#
# 使い方（このフォルダ raim_tts_sbv2_lambda で）:
#   python -I build/build_zip.py zip \
#       --site-packages build/raw/site-packages \
#       --sbv2 <Style-Bert-VITS2 を clone したフォルダ>/style_bert_vits2 \
#       --out build/dist/function.zip
#   python -I build/build_zip.py models \
#       --voice <raim_D1v4 のフォルダ（.onnx / config.json / style_vectors.npy）> \
#       --bert <bert_int8 のフォルダ（prep_bert.py の出力）> \
#       --dict <open_jtalk_dic_utf_8-1.11 のフォルダ> \
#       --out build/dist/raim_models.tar
#
# site-packages は build/Dockerfile の中身を docker cp で取り出したもの。
# style_bert_vits2 は litagin02/Style-Bert-VITS2 v2.7.0（コミット 66de777e）のまま、改変せずに入れる。
import argparse
import os
import shutil
import tarfile
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
LIMIT = 250 * 1024 * 1024  # Lambda の zip は展開後 250MB まで

# Lambda のランタイムにあるもの・推論で使わないもの
DROP = {
    "boto3", "botocore", "s3transfer", "jmespath", "dateutil", "awslambdaric", "simplejson",
    "snapshot_restore_py", "runtime_client",  # ランタイムの版を使う（SnapStart のフック）
    "numba", "llvmlite",  # 学習用（monotonic_alignment）だけで使う
    "sympy", "mpmath",  # onnxruntime の付属ツール用で、推論では読まない
    "pip", "setuptools", "_distutils_hack", "pkg_resources",  # pkg_resources は小さな代わりを入れる
    "hf_xet",  # Hugging Face からのダウンロード用（オフラインで使わない）
    "google",  # protobuf 本体（onnxruntime の推論では不要）
    "__pycache__",
}
KEEP_TRANSFORMERS_MODELS = {"encoder_decoder", "auto", "deberta_v2", "bert", "bert_japanese", "__init__.py"}
PKG_RESOURCES_STUB = '''# pyopenjtalk が import 時に使う pkg_resources.resource_filename だけの小さな代わり（setuptools を入れないため）
import importlib, os
def resource_filename(package, name):
    mod = importlib.import_module(package)
    return os.path.join(os.path.dirname(mod.__file__), name)
'''
# このフォルダの src から zip に入れるもの
SOURCE_FILES = ["handler.py", "voice_style.py", "raim_preprocess.py", "emotion_map.json", "raim_user_dict.csv"]
# AGPL の表記（zip にもライセンスとソースの場所を入れておく）
NOTICE_FILES = ["LICENSE", "THIRD_PARTY_NOTICES.md"]


def dir_size(path):
    return sum(os.path.getsize(os.path.join(r, f)) for r, _, fs in os.walk(path) for f in fs)


def package_name(entry):
    """site-packages の項目名からパッケージ名を取り出す。

    以前は「-」の前だけで判定していたので、snapshot_restore_py.py や
    runtime_client.cpython-312-x86_64-linux-gnu.so のような1ファイルのモジュールが外れなかった。
    """
    name = entry.split("-")[0]
    for suffix in (".py", ".so", ".pyd"):
        if name.endswith(suffix):
            name = name[: -len(suffix)]
    return name.split(".")[0].lower()


def build_zip(site_packages, sbv2, out):
    work = os.path.join(HERE, "pkg")
    if os.path.exists(work):
        shutil.rmtree(work)
    os.makedirs(work)

    drop_normalized = {d.replace("_", "") for d in DROP}
    for entry in os.listdir(site_packages):
        base = package_name(entry)
        if entry in DROP or base in DROP:
            continue
        if entry.endswith(".dist-info") and base.replace("_", "") in drop_normalized:
            continue
        if entry.endswith(".pth"):
            continue  # setuptools の残り（「_distutils_hack が無い」という警告の元）
        src = os.path.join(site_packages, entry)
        dst = os.path.join(work, entry)
        shutil.copytree(src, dst) if os.path.isdir(src) else shutil.copy2(src, dst)

    ort = [n for n in os.listdir(work) if n.startswith("onnxruntime-") and n.endswith(".dist-info")]
    if ort != ["onnxruntime-1.32.0.dist-info"]:
        raise SystemExit(f"onnxruntime は 1.32.0 にすること（今: {ort}）")
    if not any("x86_64" in f for f in os.listdir(os.path.join(work, "onnxruntime", "capi"))):
        raise SystemExit("x86_64 の onnxruntime ではない")

    # transformers は使うモデルの分だけ残す
    models = os.path.join(work, "transformers", "models")
    for entry in os.listdir(models):
        if entry not in KEEP_TRANSFORMERS_MODELS:
            path = os.path.join(models, entry)
            shutil.rmtree(path) if os.path.isdir(path) else os.remove(path)
    # transformers/models/__init__.py は全モデルを import するので、残したものだけ読むように書き換える
    with open(os.path.join(models, "__init__.py"), "w", encoding="utf-8") as f:
        f.write("# zip 版: 使うモデルだけ残したので、その分だけ読む\n"
                "from . import auto, bert, bert_japanese, deberta_v2, encoder_decoder\n")

    # tests と __pycache__ を消す
    for current, dirs, _ in os.walk(work, topdown=False):
        for d in dirs:
            if d in ("__pycache__", "tests", "test", "testing") and os.path.basename(current) != "numpy":
                shutil.rmtree(os.path.join(current, d), ignore_errors=True)
    # 辞書は S3 から /tmp に置く（OPEN_JTALK_DICT_DIR）。htsvoice は読み上げに使わない
    shutil.rmtree(os.path.join(work, "pyopenjtalk", "htsvoice"), ignore_errors=True)
    with open(os.path.join(work, "pkg_resources.py"), "w", encoding="utf-8") as f:
        f.write(PKG_RESOURCES_STUB)

    shutil.copytree(sbv2, os.path.join(work, "style_bert_vits2"), ignore=shutil.ignore_patterns("__pycache__"))
    for name in SOURCE_FILES:
        shutil.copy2(os.path.join(ROOT, "src", name), work)
    for name in NOTICE_FILES:
        shutil.copy2(os.path.join(ROOT, name), work)

    size = dir_size(work)
    if size > LIMIT:
        raise SystemExit(f"展開後 {size / 2**20:.1f}MB で 250MB を超えています")
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for current, _, files in os.walk(work):
            for name in files:
                path = os.path.join(current, name)
                archive.write(path, os.path.relpath(path, work).replace(os.sep, "/"))
    print(f"zip: {out} {os.path.getsize(out) / 2**20:.1f}MB（展開後 {size / 2**20:.1f}MB）")


def build_models(voice, bert, dictionary, out):
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    with tarfile.open(out, "w") as archive:  # 圧縮しない（Lambda で展開を速くする）
        for name, src in (("raim_D1v4", voice), ("bert_int8", bert), ("open_jtalk_dic", dictionary)):
            for current, _, files in os.walk(src):
                for f in files:
                    if f.endswith(".safetensors") or f == "README.txt":
                        continue
                    path = os.path.join(current, f)
                    archive.add(path, arcname=os.path.join(name, os.path.relpath(path, src)).replace(os.sep, "/"))
    print(f"models: {out} {os.path.getsize(out) / 2**20:.1f}MB")


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    z = sub.add_parser("zip")
    z.add_argument("--site-packages", required=True)
    z.add_argument("--sbv2", required=True)
    z.add_argument("--out", default=os.path.join(HERE, "dist", "function.zip"))
    m = sub.add_parser("models")
    m.add_argument("--voice", required=True)
    m.add_argument("--bert", required=True)
    m.add_argument("--dict", required=True)
    m.add_argument("--out", default=os.path.join(HERE, "dist", "raim_models.tar"))
    args = parser.parse_args()
    if args.command == "zip":
        build_zip(args.site_packages, args.sbv2, args.out)
    else:
        build_models(args.voice, args.bert, args.dict, args.out)


if __name__ == "__main__":
    main()
