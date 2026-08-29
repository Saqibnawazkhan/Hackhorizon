# Flutter and its plugins ship their own consumer ProGuard rules, so this
# file is intentionally almost empty. Add rules here only when R8 strips
# something a plugin needs and the plugin has not declared it itself.

# Keep the deep-link entry point: it is referenced from the manifest by name,
# which R8 cannot see.
-keep class com.agentflow.agentflow.MainActivity { *; }
