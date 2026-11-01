Option Explicit
Dim shell, args, repo, state, action, command, nodePath, result
Set shell = CreateObject("WScript.Shell")
Set args = WScript.Arguments
If args.Count < 4 Then WScript.Quit 2
repo = args(0)
state = args(1)
action = args(2)
nodePath = args(3)
shell.Environment("PROCESS")("CODEX_PHONE_STATE") = state
command = Chr(34) & nodePath & Chr(34) & " " & Chr(34) & repo & "\scripts\launcher.mjs" & Chr(34) & " " & Chr(34) & repo & Chr(34) & " " & Chr(34) & state & Chr(34) & " " & action
result = shell.Run(command, 0, True)
If result <> 0 Then MsgBox "Codex Phone needs attention. Run doctor --json using scripts\Manage.ps1. If Desktop was opened normally without its bridge, exit it normally including its tray icon; the companion will reopen it. Details are in your private codex-phone service.log.", 48, "Codex Phone"
