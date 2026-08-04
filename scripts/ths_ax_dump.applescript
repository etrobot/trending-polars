-- 探索脚本 v2：批量读取属性，逐行输出（stderr 实时、stdout 汇总），用于定位同花顺左侧导航 icon。
--
-- 用法：
--   osascript scripts/ths_ax_dump.applescript                 # 深度 6，窗口 1
--   osascript scripts/ths_ax_dump.applescript 4               # 指定最大深度
--   osascript scripts/ths_ax_dump.applescript 4 2             # 深度 + 窗口序号
--
-- 每行格式（| 分隔）：depth|path|role|subrole|name|description|value|x,y|w,h
--
-- 性能说明：逐元素取属性会产生成千上万次 Apple Event（实测 >3 分钟），
-- 因此这里改成「每个容器一次性批量取 role/name/... 列表」，往返次数降到层级数量级。

on run argv
	set depthLimit to 6
	set windowIndex to 1
	if (count of argv) ≥ 1 then set depthLimit to (item 1 of argv) as integer
	if (count of argv) ≥ 2 then set windowIndex to (item 2 of argv) as integer

	tell application "System Events"
		if not (exists process "同花顺") then return "同花顺进程不存在"
		tell process "同花顺"
			set windowCount to count of windows
			if windowCount is 0 then return "同花顺没有窗口"
			if windowIndex > windowCount then return "窗口序号越界，共 " & windowCount & " 个窗口"
			set targetWindow to window windowIndex
		end tell
	end tell

	set outputLines to {}
	my emit(outputLines, "== 窗口数=" & windowCount & " 窗口序号=" & windowIndex & " 深度上限=" & depthLimit & " ==")
	my emit(outputLines, "depth|path|role|subrole|name|description|value|pos|size")
	my emit(outputLines, my describeOne(targetWindow, 0, windowIndex as text))
	my dumpChildren(targetWindow, 1, windowIndex as text, depthLimit, outputLines)
	return my joinList(outputLines, linefeed)
end run

on emit(outputLines, lineText)
	set end of outputLines to lineText
	log lineText
end emit

-- 批量取一层的属性，再逐个递归。
on dumpChildren(parentElement, depth, pathText, depthLimit, outputLines)
	if depth > depthLimit then return
	set childCount to 0
	tell application "System Events"
		try
			set childCount to count of UI elements of parentElement
		end try
	end tell
	if childCount is 0 then return

	set roleList to my bulkAttribute(parentElement, "role", childCount)
	set subroleList to my bulkAttribute(parentElement, "subrole", childCount)
	set nameList to my bulkAttribute(parentElement, "name", childCount)
	set descriptionList to my bulkAttribute(parentElement, "description", childCount)
	set valueList to my bulkAttribute(parentElement, "value", childCount)
	set positionList to my bulkAttribute(parentElement, "position", childCount)
	set sizeList to my bulkAttribute(parentElement, "size", childCount)

	repeat with childIndex from 1 to childCount
		set childPath to pathText & "." & childIndex
		set fields to {depth as text, childPath}
		set end of fields to my textOf(item childIndex of roleList)
		set end of fields to my textOf(item childIndex of subroleList)
		set end of fields to my textOf(item childIndex of nameList)
		set end of fields to my textOf(item childIndex of descriptionList)
		set end of fields to my textOf(item childIndex of valueList)
		set end of fields to my pointText(item childIndex of positionList)
		set end of fields to my pointText(item childIndex of sizeList)
		my emit(outputLines, my joinList(fields, "|"))
		if depth < depthLimit then
			-- 必须用「按下标」的引用递归：按名字的引用会因为界面刷新（例如时钟文本）而失效。
			tell application "System Events"
				set childReference to UI element childIndex of parentElement
			end tell
			my dumpChildren(childReference, depth + 1, childPath, depthLimit, outputLines)
		end if
	end repeat
end dumpChildren

on bulkAttribute(parentElement, attributeName, expectedCount)
	tell application "System Events"
		try
			tell parentElement
				if attributeName is "role" then
					set rawList to role of UI elements
				else if attributeName is "subrole" then
					set rawList to subrole of UI elements
				else if attributeName is "name" then
					set rawList to name of UI elements
				else if attributeName is "description" then
					set rawList to description of UI elements
				else if attributeName is "value" then
					set rawList to value of UI elements
				else if attributeName is "position" then
					set rawList to position of UI elements
				else
					set rawList to size of UI elements
				end if
			end tell
			if (count of rawList) is expectedCount then return rawList
		end try
	end tell
	-- 批量失败（部分控件不支持该属性）时退化成占位，保证下标对齐。
	set fallbackList to {}
	repeat expectedCount times
		set end of fallbackList to missing value
	end repeat
	return fallbackList
end bulkAttribute

on textOf(rawValue)
	if rawValue is missing value then return ""
	try
		return my sanitize(rawValue as text)
	on error
		return "?"
	end try
end textOf

on pointText(rawValue)
	if rawValue is missing value then return ""
	try
		return ((item 1 of rawValue) as text) & "," & ((item 2 of rawValue) as text)
	on error
		return ""
	end try
end pointText

on describeOne(uiItem, depth, pathText)
	set fields to {depth as text, pathText}
	tell application "System Events"
		try
			set end of fields to my textOf(role of uiItem)
		on error
			set end of fields to ""
		end try
		set end of fields to ""
		try
			set end of fields to my textOf(name of uiItem)
		on error
			set end of fields to ""
		end try
		set end of fields to ""
		set end of fields to ""
		try
			set end of fields to my pointText(position of uiItem)
		on error
			set end of fields to ""
		end try
		try
			set end of fields to my pointText(size of uiItem)
		on error
			set end of fields to ""
		end try
	end tell
	return my joinList(fields, "|")
end describeOne

on sanitize(sourceText)
	set cleanText to sourceText as text
	set cleanText to my replaceText(return, " ", cleanText)
	set cleanText to my replaceText(linefeed, " ", cleanText)
	set cleanText to my replaceText("|", "｜", cleanText)
	if (count of cleanText) > 60 then set cleanText to (text 1 thru 60 of cleanText) & "…"
	return cleanText
end sanitize

on replaceText(findText, replacementText, sourceText)
	set previousDelimiters to AppleScript's text item delimiters
	set AppleScript's text item delimiters to findText
	set textItems to text items of sourceText
	set AppleScript's text item delimiters to replacementText
	set replacedText to textItems as text
	set AppleScript's text item delimiters to previousDelimiters
	return replacedText
end replaceText

on joinList(itemsToJoin, delimiterText)
	set previousDelimiters to AppleScript's text item delimiters
	set AppleScript's text item delimiters to delimiterText
	set joinedText to itemsToJoin as text
	set AppleScript's text item delimiters to previousDelimiters
	return joinedText
end joinList
