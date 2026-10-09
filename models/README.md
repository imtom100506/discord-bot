Los modelos se descargan en Docker con `npm run models:download`; no requieren
cuenta ni claves. Las descargas oficiales de k2-fsa se validan mediante SHA-256.
Los binarios se excluyen de Git. `hey-tars.txt` define pronunciaciones mediante
fonemas ingleses: HH EY1 T AA1 R Z y variantes con S/sin H inicial.

Detección: sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20, Apache-2.0.
Voz: vits-piper-es_ES-davefx-medium-int8. Dataset CC0 según MODEL_CARD incluido.
Motor: sherpa-onnx-node 1.13.8, Apache-2.0. Conserva los avisos de los archivos.
No requiere Picovoice ni modelos entrenados por el usuario.
