# 使っているもの（クレジット）

この TTS Lambda（`raim_tts_sbv2_lambda`）は AGPL-3.0（`LICENSE`）。
アプリ・サイトでは「ライムの声は Style-Bert-VITS2 で作っています」とソースの場所を表記する。

| もの | 使い方 | ライセンス | やること |
| --- | --- | --- | --- |
| [Style-Bert-VITS2](https://github.com/litagin02/Style-Bert-VITS2) v2.7.0（コミット 66de777e） | 推論（`style_bert_vits2/` を改変せず zip に入れる）、学習、ONNX 変換 | AGPL-3.0（`nlp/japanese/user_dict` は LGPL-3.0）、変換スクリプトは MIT | このフォルダのソースを公開する |
| JP-Extra の事前学習モデル | 声のモデルの学習元 | AGPL-3.0 | 同上 |
| [ku-nlp/deberta-v2-large-japanese-char-wwm](https://huggingface.co/ku-nlp/deberta-v2-large-japanese-char-wwm) | BERT（int8 に量子化して使う） | CC BY-SA 4.0 | クレジットを表記する |
| [Open JTalk](https://open-jtalk.sourceforge.net/) 辞書 open_jtalk_dic_utf_8-1.11（NAIST-jdic ベース） | 読みを決める | 修正 BSD（NAIST、UniDic Consortium、名古屋工業大学） | 著作権表示を残す（辞書の COPYING をモデル一式に同梱） |
| pyopenjtalk（pyopenjtalk-dict） | Open JTalk を Python から使う | MIT | — |
| Irodori-TTS | 学習用のお手本の声を作った（Lambda では使わない） | MIT（なりすまし禁止。透かし入り） | — |
| ONNX Runtime 1.32.0 | 推論 | MIT | — |
| numpy、transformers、tokenizers、pydantic ほか | 依存 | BSD / Apache-2.0 / MIT | — |

## クレジット表記の例

> ライムの声：Style-Bert-VITS2（litagin02、AGPL-3.0）で作成。
> BERT：ku-nlp/deberta-v2-large-japanese-char-wwm（CC BY-SA 4.0）。
> 読み：Open JTalk（名古屋工業大学）、NAIST Japanese Dictionary（奈良先端科学技術大学院大学）。
> TTS のソース：https://github.com/Andodazo/raim_aws/tree/main/raim_tts_sbv2_lambda
