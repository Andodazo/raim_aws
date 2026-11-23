# BERT（ku-nlp/deberta-v2-large-japanese-char-wwm）の ONNX を int8 に軽くする（動的量子化）。
#
# 元の model.onnx は SBV2 付属の convert_bert_onnx.py で作る。
# SBV2 の ONNX 読み込みは「<フォルダ>/model_fp16.onnx」という名前で探すので、中身は int8 だがその名前で置く。
# Conv は量子化しない（Linux の onnxruntime に ConvInteger の実装がないため）。
#
#   python build/prep_bert.py <deberta のフォルダ（model.onnx とトークナイザ一式）> <出力先 bert_int8>
import os
import shutil
import sys
import time

from onnxruntime.quantization import QuantType, quantize_dynamic

TOKENIZER_FILES = ["config.json", "special_tokens_map.json", "tokenizer.json", "tokenizer_config.json", "vocab.txt"]


def main(source, dest):
    os.makedirs(dest, exist_ok=True)
    for name in TOKENIZER_FILES:
        shutil.copy2(os.path.join(source, name), dest)
    started = time.time()
    quantize_dynamic(
        os.path.join(source, "model.onnx"),
        os.path.join(dest, "model_fp16.onnx"),
        weight_type=QuantType.QInt8,
        op_types_to_quantize=["MatMul", "Gemm"],
    )
    size = os.path.getsize(os.path.join(dest, "model_fp16.onnx")) / 1e6
    print(f"int8 done in {time.time() - started:.1f}s, {size:.1f} MB")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
