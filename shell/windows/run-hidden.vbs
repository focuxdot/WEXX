' wexx daemon 隐藏启动器(node 是控制台程序,计划任务直接拉起会闪黑窗)。
'
' 参数:
'   0 = 可执行文件路径(node.exe)
'   1 = 工作目录
'   2... = 可执行文件参数(daemon/main.mjs)
'
' WScript 会一直存活到子进程退出,任务计划程序才能观察到失败
' 并应用 RestartOnFailure。daemon 自己写 daemon.log。
Option Explicit

Dim sh, exe, workdir, cmd, i, rc
Set sh = CreateObject("WScript.Shell")

If WScript.Arguments.Count < 3 Then WScript.Quit 2

exe = WScript.Arguments(0)
workdir = WScript.Arguments(1)
If Len(workdir) > 0 Then sh.CurrentDirectory = workdir

cmd = """" & exe & """"
For i = 2 To WScript.Arguments.Count - 1
  cmd = cmd & " """ & WScript.Arguments(i) & """"
Next

rc = sh.Run(cmd, 0, True)
WScript.Quit rc
